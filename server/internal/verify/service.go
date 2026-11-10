package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/iammdzaidalam/ledger/checker"
	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/metrics"
	"github.com/iammdzaidalam/ledger/server/internal/queue"
	"github.com/iammdzaidalam/ledger/server/internal/store"
)

const (
	CheckerSource = "checker"
	JudgeKind     = "judge"
	maxRunID      = 200
)

type JudgePayload struct {
	RunID string `json:"run_id"`
	Turn  int    `json:"turn"`
}

type Service struct {
	DB            *pgxpool.Pool
	Metrics       *metrics.Metrics
	JudgeEnabled  bool
	JudgeAttempts int
	Events        events.Publisher
}

func (s *Service) Check(ctx context.Context, req *connect.Request[ledgerv1.CheckRequest]) (*connect.Response[ledgerv1.CheckResponse], error) {
	evidence, err := FromProto(req.Msg.Evidence)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	resp, _ := s.evaluate(req.Msg.TurnText, evidence, req.Msg.FreshRefs)
	return connect.NewResponse(resp), nil
}

func (s *Service) evaluate(text string, evidence []checker.Evidence, fresh []string) (*ledgerv1.CheckResponse, []checker.ClaimResult) {
	started := time.Now()
	result := checker.Evaluate(checker.CheckRequest{TurnText: text, Evidence: evidence, FreshRefs: fresh})
	elapsed := time.Since(started)
	if s.Metrics != nil {
		s.Metrics.Check.Observe(elapsed.Seconds())
		for _, c := range result.Claims {
			s.Metrics.Claims.WithLabelValues(string(c.Kind), string(c.Verdict)).Inc()
		}
	}
	return &ledgerv1.CheckResponse{
		Claims:    ClaimsToProto(result.Claims),
		Flagged:   Flagged(result.Claims),
		LatencyUs: elapsed.Microseconds(),
	}, result.Claims
}

func Flagged(claims []checker.ClaimResult) bool {
	for _, c := range claims {
		if c.Verdict == checker.Contradicted || c.Verdict == checker.Unsupported {
			return true
		}
	}
	return false
}

func (s *Service) RecordTurn(ctx context.Context, req *connect.Request[ledgerv1.RecordTurnRequest]) (*connect.Response[ledgerv1.RecordTurnResponse], error) {
	m := req.Msg
	if m.RunId == "" || len(m.RunId) > maxRunID {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("run_id must be 1-%d characters", maxRunID))
	}
	if m.Turn < 1 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("turn starts at 1"))
	}
	evidence, err := FromProto(m.Evidence)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	encoded, err := json.Marshal(evidence)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	info := store.RunInfo{}
	if m.Run != nil {
		info = store.RunInfo{Source: m.Run.Source, Model: m.Run.Model, Task: m.Run.Task}
	}

	out := &ledgerv1.RecordTurnResponse{}
	outcome := "new"
	err = pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		if err := store.EnsureRun(ctx, tx, m.RunId, info); err != nil {
			return err
		}
		inserted, err := store.InsertTurn(ctx, tx, store.Turn{
			RunID: m.RunId, Turn: int(m.Turn), Text: m.TurnText, Evidence: encoded, FreshRefs: m.FreshRefs,
		})
		if err != nil {
			return err
		}
		if !inserted {
			outcome = "duplicate"
			out.Duplicate = true
			v, err := store.GetVerdict(ctx, tx, m.RunId, int(m.Turn), CheckerSource)
			if err != nil {
				return err
			}
			var claims []checker.ClaimResult
			if err := json.Unmarshal(v.Claims, &claims); err != nil {
				return err
			}
			out.Check = &ledgerv1.CheckResponse{Claims: ClaimsToProto(claims), Flagged: v.Flagged, LatencyUs: v.LatencyUs}
			return nil
		}
		check, claims := s.evaluate(m.TurnText, evidence, m.FreshRefs)
		out.Check = check
		body, err := json.Marshal(claims)
		if err != nil {
			return err
		}
		if err := store.PutVerdict(ctx, tx, store.Verdict{
			RunID: m.RunId, Turn: int(m.Turn), Source: CheckerSource,
			Flagged: check.Flagged, Claims: body, LatencyUs: check.LatencyUs,
		}); err != nil {
			return err
		}
		if m.Judge && s.JudgeEnabled {
			if _, err := queue.Enqueue(ctx, tx, JudgeKind, JudgePayload{RunID: m.RunId, Turn: int(m.Turn)}, s.JudgeAttempts); err != nil {
				return err
			}
			out.JudgeQueued = true
		}
		return nil
	})
	if errors.Is(err, store.ErrTurnConflict) {
		outcome = "conflict"
		err = connect.NewError(connect.CodeAlreadyExists, fmt.Errorf("turn %d of run %s: %w", m.Turn, m.RunId, err))
	}
	if s.Metrics != nil {
		s.Metrics.Turns.WithLabelValues(outcome).Inc()
	}
	if err != nil {
		return nil, err
	}
	if outcome == "new" {
		s.publishTurn(ctx, m.RunId, int(m.Turn), out.Check)
	}
	return connect.NewResponse(out), nil
}

func (s *Service) publishTurn(ctx context.Context, runID string, turn int, check *ledgerv1.CheckResponse) {
	if s.Events == nil {
		return
	}
	swarmID, taskID, ok, err := store.AttemptOwner(ctx, s.DB, runID)
	if err != nil || !ok {
		return
	}
	state := "clean"
	if check.Flagged {
		state = "flagged"
	}
	s.Events.Publish(ctx, events.Event{
		SwarmID: swarmID, TaskID: taskID, AttemptID: runID, Type: events.AttemptTurn,
		Message: fmt.Sprintf("turn %d %s", turn, state),
		Data:    map[string]any{"turn": turn, "flagged": check.Flagged, "claims": len(check.Claims)},
		At:      time.Now().UTC(),
	})
}

func (s *Service) GetRun(ctx context.Context, req *connect.Request[ledgerv1.GetRunRequest]) (*connect.Response[ledgerv1.GetRunResponse], error) {
	run, turns, err := store.GetRun(ctx, s.DB, req.Msg.RunId)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no run %q", req.Msg.RunId))
	}
	if err != nil {
		return nil, err
	}
	out := &ledgerv1.GetRunResponse{Run: runToProto(run)}
	for _, t := range turns {
		pt := &ledgerv1.Turn{Turn: int32(t.Turn), Text: t.Text, EvidenceCount: int32(t.EvidenceCount)}
		for _, v := range t.Verdicts {
			var claims []checker.ClaimResult
			_ = json.Unmarshal(v.Claims, &claims)
			pt.Verdicts = append(pt.Verdicts, &ledgerv1.Verdict{
				Source: v.Source, Flagged: v.Flagged, Claims: ClaimsToProto(claims),
				LatencyUs: v.LatencyUs, CreatedAt: timestamppb.New(v.CreatedAt),
			})
		}
		out.Turns = append(out.Turns, pt)
	}
	return connect.NewResponse(out), nil
}

func (s *Service) ListRuns(ctx context.Context, req *connect.Request[ledgerv1.ListRunsRequest]) (*connect.Response[ledgerv1.ListRunsResponse], error) {
	limit := int(req.Msg.Limit)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	before, beforeID := time.Now().Add(time.Hour), ""
	if req.Msg.Before != "" {
		stamp, id, _ := strings.Cut(req.Msg.Before, "|")
		t, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("before: %w", err))
		}
		before, beforeID = t, id
	}
	runs, err := store.ListRuns(ctx, s.DB, limit, before, beforeID)
	if err != nil {
		return nil, err
	}
	out := &ledgerv1.ListRunsResponse{}
	for _, r := range runs {
		out.Runs = append(out.Runs, runToProto(r))
	}
	if len(runs) == limit {
		last := runs[len(runs)-1]
		out.Next = last.CreatedAt.Format(time.RFC3339Nano) + "|" + last.ID
	}
	return connect.NewResponse(out), nil
}

func runToProto(r store.RunSummary) *ledgerv1.Run {
	return &ledgerv1.Run{
		Id:        r.ID,
		Info:      &ledgerv1.RunInfo{Source: r.Info.Source, Model: r.Info.Model, Task: r.Info.Task},
		Turns:     int32(r.Turns),
		Flagged:   int32(r.Flagged),
		CreatedAt: timestamppb.New(r.CreatedAt),
	}
}

func FromProto(in []*ledgerv1.Evidence) ([]checker.Evidence, error) {
	out := make([]checker.Evidence, 0, len(in))
	for i, e := range in {
		if e.Tool == "" {
			return nil, fmt.Errorf("evidence[%d]: tool is required", i)
		}
		var exit *int
		if e.ExitCode != nil {
			v := int(*e.ExitCode)
			exit = &v
		}
		args := map[string]interface{}{}
		if e.Args != nil {
			args = e.Args.AsMap()
		}
		out = append(out, checker.Evidence{
			Ref: e.Ref, Seq: int(e.Seq), Tool: e.Tool, Args: args,
			RawStdout: e.RawStdout, RawStderr: e.RawStderr, ExitCode: exit,
			Executed: e.Executed, IsError: e.IsError, DurationMs: e.DurationMs, Diff: e.Diff,
		})
	}
	return out, nil
}

func ToProto(in []checker.Evidence) ([]*ledgerv1.Evidence, error) {
	out := make([]*ledgerv1.Evidence, 0, len(in))
	for _, e := range in {
		args, err := structpb.NewStruct(e.Args)
		if err != nil {
			return nil, err
		}
		var exit *int32
		if e.ExitCode != nil {
			v := int32(*e.ExitCode)
			exit = &v
		}
		out = append(out, &ledgerv1.Evidence{
			Ref: e.Ref, Seq: int32(e.Seq), Tool: e.Tool, Args: args,
			RawStdout: e.RawStdout, RawStderr: e.RawStderr, ExitCode: exit,
			Executed: e.Executed, IsError: e.IsError, DurationMs: e.DurationMs, Diff: e.Diff,
		})
	}
	return out, nil
}

func ClaimsToProto(in []checker.ClaimResult) []*ledgerv1.Claim {
	out := make([]*ledgerv1.Claim, 0, len(in))
	for _, c := range in {
		out = append(out, &ledgerv1.Claim{
			Text: c.Text, Kind: string(c.Kind), Ref: c.Ref, Attribution: string(c.Attribution),
			Verdict: string(c.Verdict), Rule: c.Rule, Reason: c.Reason,
		})
	}
	return out
}

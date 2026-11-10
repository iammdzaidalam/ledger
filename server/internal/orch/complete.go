package orch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	"github.com/iammdzaidalam/ledger/checker"
	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/store"
	"github.com/iammdzaidalam/ledger/server/internal/verify"
)

type attemptRow struct {
	Number       int
	Worker       string
	State        string
	Decision     string
	Reason       string
	FlaggedTurns int
	Turns        int
	Seconds      float64
}

type runStats struct {
	Turns       int
	Flagged     int
	LastFlagged bool
	LastClaims  []checker.ClaimResult
}

func readRunStats(ctx context.Context, tx pgx.Tx, runID string) (runStats, error) {
	var st runStats
	err := tx.QueryRow(ctx, `select count(*) from turns where run_id = $1`, runID).Scan(&st.Turns)
	if err != nil {
		return st, err
	}
	err = tx.QueryRow(ctx, `select count(*) from verdicts where run_id = $1 and source = $2 and flagged`, runID, verify.CheckerSource).Scan(&st.Flagged)
	if err != nil {
		return st, err
	}
	var claims []byte
	err = tx.QueryRow(ctx, `
		select flagged, claims from verdicts where run_id = $1 and source = $2 order by turn desc limit 1`,
		runID, verify.CheckerSource).Scan(&st.LastFlagged, &claims)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(claims, &st.LastClaims)
}

func (s *Service) CompleteAttempt(ctx context.Context, req *connect.Request[ledgerv1.CompleteAttemptRequest]) (*connect.Response[ledgerv1.CompleteAttemptResponse], error) {
	m := req.Msg
	if m.AttemptId == "" || m.WorkerId == "" {
		return nil, invalid("attempt_id and worker_id are required")
	}
	swarmID, taskID, ok, err := store.AttemptOwner(ctx, s.DB, m.AttemptId)
	if err != nil {
		return nil, asConnect(err)
	}
	if !ok {
		return nil, notFound("no attempt %q", m.AttemptId)
	}

	var resp *ledgerv1.CompleteAttemptResponse
	err = s.tx(ctx, "complete_attempt", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		sw, found, err := lockSwarm(ctx, tx, swarmID, false)
		if err != nil {
			return err
		}
		if !found {
			return notFound("no swarm %q", swarmID)
		}
		var taskState, title string
		if err := tx.QueryRow(ctx, `select state, title from tasks where id = $1 for update`, taskID).Scan(&taskState, &title); err != nil {
			return err
		}
		var a attemptRow
		err = tx.QueryRow(ctx, `
			select number, worker_id, state, decision, reason, flagged_turns, turns, extract(epoch from now() - started_at)
			from attempts where id = $1 for update`, m.AttemptId).
			Scan(&a.Number, &a.Worker, &a.State, &a.Decision, &a.Reason, &a.FlaggedTurns, &a.Turns, &a.Seconds)
		if err != nil {
			return err
		}
		if a.Worker != m.WorkerId {
			return precondition("attempt %s belongs to worker %s, not %s", m.AttemptId, a.Worker, m.WorkerId)
		}
		switch a.State {
		case "done":
			resp = &ledgerv1.CompleteAttemptResponse{
				Decision: decision(a.Decision), Reason: a.Reason, FlaggedTurns: int32(a.FlaggedTurns), Turns: int32(a.Turns),
			}
			return nil
		case "expired":
			return precondition("attempt %s lost its lease and was closed; a newer attempt owns the task", m.AttemptId)
		case "cancelled":
			resp = &ledgerv1.CompleteAttemptResponse{Decision: ledgerv1.GateDecision_GATE_DECISION_FAIL, Reason: "swarm cancelled"}
			return nil
		}

		stats, err := readRunStats(ctx, tx, m.AttemptId)
		if err != nil {
			return err
		}
		result := Decide(GateInput{
			Gate: sw.Gate, ExitCode: int(m.ExitCode), Error: m.Error, Branch: m.Branch, Commit: m.Commit,
			LastFlagged: stats.LastFlagged, Attempt: a.Number, MaxAttempts: sw.MaxAttempts,
		})
		if err := s.apply(ctx, tx, out, applyArgs{
			swarmID: swarmID, taskID: taskID, attemptID: m.AttemptId, number: a.Number, seconds: a.Seconds,
			req: m, stats: stats, result: result,
		}); err != nil {
			return err
		}
		resp = &ledgerv1.CompleteAttemptResponse{
			Decision: result.Decision, Reason: result.Reason, FlaggedTurns: int32(stats.Flagged), Turns: int32(stats.Turns),
		}
		return nil
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(resp), nil
}

type applyArgs struct {
	swarmID, taskID, attemptID string
	number                     int
	seconds                    float64
	req                        *ledgerv1.CompleteAttemptRequest
	stats                      runStats
	result                     GateResult
}

func (s *Service) apply(ctx context.Context, tx pgx.Tx, out *outbox, p applyArgs) error {
	name := decisionName(p.result.Decision)
	_, err := tx.Exec(ctx, `
		update attempts set state = 'done', decision = $2, reason = $3, branch = $4, commit_sha = $5, exit_code = $6,
			flagged_turns = $7, turns = $8, summary = $9, error = $10, finished_at = now()
		where id = $1`,
		p.attemptID, name, p.result.Reason, p.req.Branch, p.req.Commit, p.req.ExitCode,
		p.stats.Flagged, p.stats.Turns, p.req.Summary, p.req.Error)
	if err != nil {
		return err
	}

	data := map[string]any{"attempt": p.number, "reason": p.result.Reason, "flagged_turns": p.stats.Flagged, "turns": p.stats.Turns}
	base := events.Event{SwarmID: p.swarmID, TaskID: p.taskID, AttemptID: p.attemptID}
	done := base
	done.Type, done.Message = events.AttemptDone, fmt.Sprintf("attempt %d finished with exit code %d", p.number, p.req.ExitCode)
	done.Data = map[string]any{"exit_code": p.req.ExitCode, "decision": name, "branch": p.req.Branch, "commit": p.req.Commit}
	out.emit(done)

	gate := base
	gate.Message, gate.Data = p.result.Reason, data
	outcome := ""
	switch p.result.Decision {
	case ledgerv1.GateDecision_GATE_DECISION_PASS:
		err = transition(ctx, tx, p.taskID, "running", "passed", "")
		if err == nil {
			_, err = tx.Exec(ctx, `update tasks set branch = $2, commit_sha = $3 where id = $1`, p.taskID, p.req.Branch, p.req.Commit)
		}
		gate.Type, outcome = events.GatePass, "passed"
	case ledgerv1.GateDecision_GATE_DECISION_RETRY:
		feedback := Feedback(p.stats.LastClaims)
		err = transition(ctx, tx, p.taskID, "running", "queued", "")
		if err == nil {
			_, err = tx.Exec(ctx, `update tasks set feedback = $2 where id = $1`, p.taskID, feedback)
		}
		gate.Type, outcome = events.GateRetry, "retried"
		gate.Data["feedback"] = feedback
		out.emit(events.Event{SwarmID: p.swarmID, TaskID: p.taskID, Type: events.TaskQueued,
			Message: "retry with feedback", Data: map[string]any{"attempt": p.number + 1}})
	case ledgerv1.GateDecision_GATE_DECISION_BLOCK:
		err = transition(ctx, tx, p.taskID, "running", "blocked", p.result.Reason)
		gate.Type, outcome = events.GateBlock, "blocked"
	default:
		err = transition(ctx, tx, p.taskID, "running", "failed", p.result.Reason)
		gate.Type, outcome = events.GateFail, "failed"
	}
	if err != nil {
		return err
	}
	out.emit(gate)
	if err := finishIfDone(ctx, tx, out, p.swarmID); err != nil {
		return err
	}
	out.after(func() {
		if s.Metrics != nil {
			s.Metrics.GateDecisions.WithLabelValues(name).Inc()
			s.Metrics.Attempts.WithLabelValues(outcome).Inc()
			s.Metrics.AttemptTime.Observe(p.seconds)
		}
	})
	return nil
}

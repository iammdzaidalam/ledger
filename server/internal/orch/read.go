package orch

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/store"
)

const swarmColumns = `
	s.id, s.goal, s.repo, s.base_ref, s.model, s.gate, s.max_attempts, s.state, s.created_at, s.finished_at,
	coalesce((select jsonb_object_agg(c.state, c.n) from
		(select state, count(*) n from tasks where swarm_id = s.id group by state) c), '{}')`

func scanSwarm(row pgx.Row) (*ledgerv1.Swarm, error) {
	var sw ledgerv1.Swarm
	var state string
	var created time.Time
	var finished *time.Time
	var raw []byte
	err := row.Scan(&sw.Id, &sw.Goal, &sw.Repo, &sw.BaseRef, &sw.Model, &sw.Gate, &sw.MaxAttempts, &state, &created, &finished, &raw)
	if err != nil {
		return nil, err
	}
	sw.State = swarmState(state)
	sw.CreatedAt = timestamppb.New(created)
	sw.FinishedAt = stamp(finished)
	sw.TaskCounts = counts(raw)
	return &sw, nil
}

func loadSwarm(ctx context.Context, db store.DB, id string) (*ledgerv1.Swarm, error) {
	sw, err := scanSwarm(db.QueryRow(ctx, `select `+swarmColumns+` from swarms s where s.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("no swarm %q", id)
	}
	return sw, err
}

const attemptColumns = `
	a.id, a.task_id, a.number, a.worker_id, a.state, a.decision, a.feedback, a.branch, a.commit_sha, a.exit_code,
	case when a.finished_at is null then (select count(distinct v.turn) from verdicts v where v.run_id = a.id and v.source = 'checker' and v.flagged)
	     else a.flagged_turns end,
	case when a.finished_at is null then (select count(*) from turns t where t.run_id = a.id) else a.turns end,
	a.started_at, a.finished_at`

func loadAttempts(ctx context.Context, db store.DB, taskIDs []string) (map[string][]*ledgerv1.Attempt, error) {
	rows, err := db.Query(ctx, `select `+attemptColumns+` from attempts a where a.task_id = any($1) order by a.task_id, a.number`, taskIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]*ledgerv1.Attempt{}
	for rows.Next() {
		var a ledgerv1.Attempt
		var taskID, state, dec string
		var started time.Time
		var finished *time.Time
		err := rows.Scan(&a.Id, &taskID, &a.Number, &a.WorkerId, &state, &dec, &a.Feedback, &a.Branch, &a.Commit,
			&a.ExitCode, &a.FlaggedTurns, &a.Turns, &started, &finished)
		if err != nil {
			return nil, err
		}
		a.RunId = a.Id
		a.Decision = decision(dec)
		a.StartedAt = timestamppb.New(started)
		a.FinishedAt = stamp(finished)
		out[taskID] = append(out[taskID], &a)
	}
	return out, rows.Err()
}

func loadTasks(ctx context.Context, db store.DB, where string, args ...any) ([]*ledgerv1.Task, error) {
	rows, err := db.Query(ctx, `select id, swarm_id, idx, title, prompt, state, detail from tasks where `+where+` order by swarm_id, idx`, args...)
	if err != nil {
		return nil, err
	}
	var tasks []*ledgerv1.Task
	var ids []string
	for rows.Next() {
		var t ledgerv1.Task
		var state string
		if err := rows.Scan(&t.Id, &t.SwarmId, &t.Index, &t.Title, &t.Prompt, &state, &t.Detail); err != nil {
			rows.Close()
			return nil, err
		}
		t.State = taskState(state)
		tasks = append(tasks, &t)
		ids = append(ids, t.Id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	attempts, err := loadAttempts(ctx, db, ids)
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		t.Attempts = attempts[t.Id]
	}
	return tasks, nil
}

func (s *Service) GetSwarm(ctx context.Context, req *connect.Request[ledgerv1.GetSwarmRequest]) (*connect.Response[ledgerv1.GetSwarmResponse], error) {
	sw, err := loadSwarm(ctx, s.DB, req.Msg.SwarmId)
	if err != nil {
		return nil, asConnect(err)
	}
	tasks, err := loadTasks(ctx, s.DB, `swarm_id = $1`, sw.Id)
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(&ledgerv1.GetSwarmResponse{Swarm: sw, Tasks: tasks}), nil
}

func (s *Service) ListSwarms(ctx context.Context, req *connect.Request[ledgerv1.ListSwarmsRequest]) (*connect.Response[ledgerv1.ListSwarmsResponse], error) {
	limit := int(req.Msg.Limit)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `select ` + swarmColumns + ` from swarms s`
	args := []any{limit + 1}
	if req.Msg.Before != "" {
		at, id, err := parseCursor(req.Msg.Before)
		if err != nil {
			return nil, invalid("before: %v", err)
		}
		query += ` where (s.created_at, s.id) < ($2::timestamptz, $3::text)`
		args = append(args, at, id)
	}
	rows, err := s.DB.Query(ctx, query+` order by s.created_at desc, s.id desc limit $1`, args...)
	if err != nil {
		return nil, asConnect(err)
	}
	defer rows.Close()
	out := &ledgerv1.ListSwarmsResponse{}
	for rows.Next() {
		sw, err := scanSwarm(rows)
		if err != nil {
			return nil, asConnect(err)
		}
		out.Swarms = append(out.Swarms, sw)
	}
	if err := rows.Err(); err != nil {
		return nil, asConnect(err)
	}
	if len(out.Swarms) > limit {
		out.Swarms = out.Swarms[:limit]
		last := out.Swarms[limit-1]
		out.Next = cursor(last.CreatedAt.AsTime(), last.Id)
	}
	return connect.NewResponse(out), nil
}

func cursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
}

func parseCursor(raw string) (time.Time, string, error) {
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, "", err
	}
	stamp, id, ok := strings.Cut(string(body), "|")
	if !ok || id == "" {
		return time.Time{}, "", fmt.Errorf("malformed cursor")
	}
	at, err := time.Parse(time.RFC3339Nano, stamp)
	return at, id, err
}

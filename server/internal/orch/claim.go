package orch

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/store"
)

func branchName(swarmID string, idx int) string {
	return fmt.Sprintf("ledger/fleet-%s-%d", swarmID[:min(8, len(swarmID))], idx+1)
}

func (s *Service) ClaimAttempt(ctx context.Context, req *connect.Request[ledgerv1.ClaimAttemptRequest]) (*connect.Response[ledgerv1.ClaimAttemptResponse], error) {
	m := req.Msg
	if m.WorkerId == "" {
		return nil, invalid("worker_id is required")
	}
	lease := clampLease(m.LeaseSeconds)
	if _, err := s.reapExpired(ctx, m.SwarmId); err != nil {
		s.log().Warn("reap before claim", "err", err)
	}

	var assignment *ledgerv1.Assignment
	err := s.tx(ctx, "claim_attempt", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		a := &ledgerv1.Assignment{LeaseSeconds: int32(lease)}
		var idx, used int
		err := tx.QueryRow(ctx, `
			select t.id, t.swarm_id, t.idx, t.title, t.prompt, t.feedback, t.attempts, s.repo, s.base_ref, s.model
			from tasks t join swarms s on s.id = t.swarm_id
			where t.state = 'queued' and s.state = 'running' and ($1::text = '' or t.swarm_id = $1)
			order by t.created_at, t.idx
			limit 1
			for update of t skip locked`, m.SwarmId).
			Scan(&a.TaskId, &a.SwarmId, &idx, &a.Title, &a.Prompt, &a.Feedback, &used, &a.Repo, &a.BaseRef, &a.Model)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		a.AttemptId = newID()
		a.RunId = a.AttemptId
		a.AttemptNumber = int32(used + 1)
		a.Branch = branchName(a.SwarmId, idx)

		if err := transition(ctx, tx, a.TaskId, "queued", "running", ""); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update tasks set attempts = attempts + 1 where id = $1`, a.TaskId); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			insert into attempts (id, task_id, swarm_id, number, worker_id, lease_seconds, feedback, leased_until)
			values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $6::int))`,
			a.AttemptId, a.TaskId, a.SwarmId, a.AttemptNumber, m.WorkerId, lease, a.Feedback)
		if err != nil {
			return err
		}
		label := a.Title
		if label == "" {
			label = a.Prompt
		}
		if err := store.EnsureRun(ctx, tx, a.RunId, store.RunInfo{Source: "fleet", Model: a.Model, Task: label}); err != nil {
			return err
		}
		out.emit(events.Event{SwarmID: a.SwarmId, TaskID: a.TaskId, AttemptID: a.AttemptId, Type: events.TaskClaimed,
			Message: fmt.Sprintf("%s took attempt %d", m.WorkerId, a.AttemptNumber),
			Data:    map[string]any{"worker_id": m.WorkerId, "attempt": a.AttemptNumber, "has_feedback": a.Feedback != ""}})
		assignment = a
		return nil
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(&ledgerv1.ClaimAttemptResponse{Assignment: assignment}), nil
}

func (s *Service) Heartbeat(ctx context.Context, req *connect.Request[ledgerv1.HeartbeatRequest]) (*connect.Response[ledgerv1.HeartbeatResponse], error) {
	m := req.Msg
	if m.AttemptId == "" || m.WorkerId == "" {
		return nil, invalid("attempt_id and worker_id are required")
	}
	tag, err := s.DB.Exec(ctx, `
		update attempts set leased_until = now() + make_interval(secs => lease_seconds)
		where id = $1 and worker_id = $2 and state = 'running'`, m.AttemptId, m.WorkerId)
	if err != nil {
		return nil, asConnect(err)
	}
	if tag.RowsAffected() == 1 {
		return connect.NewResponse(&ledgerv1.HeartbeatResponse{LeaseHeld: true}), nil
	}
	var worker, state string
	err = s.DB.QueryRow(ctx, `select worker_id, state from attempts where id = $1`, m.AttemptId).Scan(&worker, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("no attempt %q", m.AttemptId)
	}
	if err != nil {
		return nil, asConnect(err)
	}
	if worker != m.WorkerId {
		return nil, precondition("attempt %s belongs to worker %s, not %s", m.AttemptId, worker, m.WorkerId)
	}
	return connect.NewResponse(&ledgerv1.HeartbeatResponse{Cancelled: state == "cancelled"}), nil
}

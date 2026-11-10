package orch

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
)

func (s *Service) ClaimMerge(ctx context.Context, req *connect.Request[ledgerv1.ClaimMergeRequest]) (*connect.Response[ledgerv1.ClaimMergeResponse], error) {
	m := req.Msg
	if m.SwarmId == "" || m.WorkerId == "" {
		return nil, invalid("swarm_id and worker_id are required")
	}
	lease := clampLease(m.LeaseSeconds)
	resp := &ledgerv1.ClaimMergeResponse{}
	err := s.tx(ctx, "claim_merge", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		resp = &ledgerv1.ClaimMergeResponse{}
		sw, ok, err := lockSwarm(ctx, tx, m.SwarmId, false)
		if err != nil {
			return err
		}
		if !ok {
			return notFound("no swarm %q", m.SwarmId)
		}
		if sw.State == "running" {
			job, err := pickMerge(ctx, tx, m, lease)
			if err != nil {
				return err
			}
			if job != nil {
				resp.Job = job
				out.emit(events.Event{SwarmID: job.SwarmId, TaskID: job.TaskId, Type: events.TaskMerging,
					Message: job.Title, Data: map[string]any{"worker_id": m.WorkerId, "branch": job.Branch, "commit": job.Commit}})
			}
		}
		if resp.Job == nil {
			active, err := hasActive(ctx, tx, m.SwarmId)
			if err != nil {
				return err
			}
			resp.SwarmFinished = !active
		}
		return nil
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(resp), nil
}

func pickMerge(ctx context.Context, tx pgx.Tx, m *ledgerv1.ClaimMergeRequest, lease int) (*ledgerv1.MergeJob, error) {
	job := &ledgerv1.MergeJob{SwarmId: m.SwarmId}
	var held bool
	var holder string
	err := tx.QueryRow(ctx, `
		select id, branch, commit_sha, title, merge_worker, merge_until > now()
		from tasks where swarm_id = $1 and state = 'merging' for update`, m.SwarmId).
		Scan(&job.TaskId, &job.Branch, &job.Commit, &job.Title, &holder, &held)
	switch {
	case err == nil:
		if held && holder != m.WorkerId {
			return nil, nil
		}
	case errors.Is(err, pgx.ErrNoRows):
		err = tx.QueryRow(ctx, `
			select id, branch, commit_sha, title from tasks
			where swarm_id = $1 and state = 'passed' order by idx limit 1 for update`, m.SwarmId).
			Scan(&job.TaskId, &job.Branch, &job.Commit, &job.Title)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if err := transition(ctx, tx, job.TaskId, "passed", "merging", ""); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	_, err = tx.Exec(ctx, `
		update tasks set merge_worker = $2, merge_until = now() + make_interval(secs => $3::int) where id = $1`,
		job.TaskId, m.WorkerId, lease)
	if err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `select repo from swarms where id = $1`, m.SwarmId).Scan(&job.Repo)
	return job, err
}

func (s *Service) FinishMerge(ctx context.Context, req *connect.Request[ledgerv1.FinishMergeRequest]) (*connect.Response[ledgerv1.FinishMergeResponse], error) {
	m := req.Msg
	if m.TaskId == "" || m.WorkerId == "" {
		return nil, invalid("task_id and worker_id are required")
	}
	var swarmID string
	err := s.DB.QueryRow(ctx, `select swarm_id from tasks where id = $1`, m.TaskId).Scan(&swarmID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("no task %q", m.TaskId)
	}
	if err != nil {
		return nil, asConnect(err)
	}
	want, event := "conflict", events.TaskConflict
	if m.Merged {
		want, event = "merged", events.TaskMerged
	}
	var task *ledgerv1.Task
	err = s.tx(ctx, "finish_merge", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		if _, _, err := lockSwarm(ctx, tx, swarmID, false); err != nil {
			return err
		}
		var state, holder string
		if err := tx.QueryRow(ctx, `select state, merge_worker from tasks where id = $1 for update`, m.TaskId).Scan(&state, &holder); err != nil {
			return err
		}
		if state == want {
			return loadOne(ctx, tx, m.TaskId, &task)
		}
		if state != "merging" {
			return precondition("task %s is %s, not merging", m.TaskId, state)
		}
		if holder != m.WorkerId {
			return precondition("task %s is being merged by %s, not %s", m.TaskId, holder, m.WorkerId)
		}
		if err := transition(ctx, tx, m.TaskId, "merging", want, m.Detail); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update tasks set merge_until = null where id = $1`, m.TaskId); err != nil {
			return err
		}
		out.emit(events.Event{SwarmID: swarmID, TaskID: m.TaskId, Type: event, Message: m.Detail,
			Data: map[string]any{"worker_id": m.WorkerId}})
		if err := finishIfDone(ctx, tx, out, swarmID); err != nil {
			return err
		}
		return loadOne(ctx, tx, m.TaskId, &task)
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(&ledgerv1.FinishMergeResponse{Task: task}), nil
}

func loadOne(ctx context.Context, tx pgx.Tx, id string, dst **ledgerv1.Task) error {
	tasks, err := loadTasks(ctx, tx, `id = $1`, id)
	if err != nil {
		return err
	}
	*dst = tasks[0]
	return nil
}

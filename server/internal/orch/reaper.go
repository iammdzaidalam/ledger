package orch

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/iammdzaidalam/ledger/server/internal/events"
)

type expired struct {
	attemptID string
	taskID    string
	swarmID   string
}

func (s *Service) expiredAttempts(ctx context.Context, swarmID string) ([]expired, error) {
	rows, err := s.DB.Query(ctx, `
		select id, task_id, swarm_id from attempts
		where state = 'running' and leased_until < now() and ($1::text = '' or swarm_id = $1)
		order by leased_until limit 100`, swarmID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []expired
	for rows.Next() {
		var e expired
		if err := rows.Scan(&e.attemptID, &e.taskID, &e.swarmID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Service) reapExpired(ctx context.Context, swarmID string) (int, error) {
	list, err := s.expiredAttempts(ctx, swarmID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range list {
		reaped, err := s.reapOne(ctx, e)
		if err != nil {
			return n, err
		}
		if reaped {
			n++
		}
	}
	return n, nil
}

func (s *Service) Reap(ctx context.Context) (int, error) { return s.reapExpired(ctx, "") }

func (s *Service) RunReaper(ctx context.Context, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if n, err := s.Reap(ctx); err != nil {
				if ctx.Err() == nil {
					s.log().Warn("reaper", "err", err)
				}
			} else if n > 0 {
				s.log().Info("reaped expired attempts", "count", n)
			}
		}
	}
}

func (s *Service) reapOne(ctx context.Context, e expired) (bool, error) {
	reaped := false
	err := s.tx(ctx, "reap_attempt", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		reaped = false
		sw, ok, err := lockSwarm(ctx, tx, e.swarmID, true)
		if err != nil || !ok {
			return err
		}
		var taskState string
		if err := tx.QueryRow(ctx, `select state from tasks where id = $1 for update`, e.taskID).Scan(&taskState); err != nil {
			return err
		}
		var number int
		var worker string
		var seconds float64
		err = tx.QueryRow(ctx, `
			select number, worker_id, extract(epoch from now() - started_at) from attempts
			where id = $1 and state = 'running' and leased_until < now()
			for update skip locked`, e.attemptID).Scan(&number, &worker, &seconds)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			update attempts set state = 'expired', reason = 'lease expired', finished_at = now() where id = $1`, e.attemptID); err != nil {
			return err
		}
		requeued := false
		if taskState == "running" {
			if number < sw.MaxAttempts {
				requeued = true
				err = transition(ctx, tx, e.taskID, "running", "queued", "")
			} else {
				err = transition(ctx, tx, e.taskID, "running", "failed",
					fmt.Sprintf("lease expired on attempt %d of %d", number, sw.MaxAttempts))
			}
			if err != nil {
				return err
			}
		}
		out.emit(events.Event{SwarmID: e.swarmID, TaskID: e.taskID, AttemptID: e.attemptID, Type: events.HeartbeatLost,
			Message: fmt.Sprintf("attempt %d lost its worker %s", number, worker),
			Data:    map[string]any{"attempt": number, "worker_id": worker, "requeued": requeued}})
		if requeued {
			out.emit(events.Event{SwarmID: e.swarmID, TaskID: e.taskID, Type: events.TaskQueued,
				Message: "requeued after lost worker", Data: map[string]any{"attempt": number + 1}})
		}
		if err := finishIfDone(ctx, tx, out, e.swarmID); err != nil {
			return err
		}
		reaped = true
		out.after(func() {
			if s.Metrics != nil {
				s.Metrics.LeaseExpired.Inc()
				s.Metrics.Attempts.WithLabelValues("expired").Inc()
				s.Metrics.AttemptTime.Observe(seconds)
			}
		})
		return nil
	})
	return reaped, err
}

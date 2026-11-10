package orch

import (
	"context"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
)

func (s *Service) CancelSwarm(ctx context.Context, req *connect.Request[ledgerv1.CancelSwarmRequest]) (*connect.Response[ledgerv1.CancelSwarmResponse], error) {
	id := req.Msg.SwarmId
	if id == "" {
		return nil, invalid("swarm_id is required")
	}
	var swarm *ledgerv1.Swarm
	err := s.tx(ctx, "cancel_swarm", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		sw, ok, err := lockSwarm(ctx, tx, id, false)
		if err != nil {
			return err
		}
		if !ok {
			return notFound("no swarm %q", id)
		}
		if sw.State == "running" {
			tag, err := tx.Exec(ctx, `
				update tasks set state = 'cancelled', detail = 'swarm cancelled', updated_at = now()
				where swarm_id = $1 and state in ('queued', 'running', 'passed')`, id)
			if err != nil {
				return err
			}
			closed, err := tx.Exec(ctx, `
				update attempts set state = 'cancelled', reason = 'swarm cancelled', finished_at = now()
				where swarm_id = $1 and state = 'running'`, id)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `update swarms set state = 'cancelled', finished_at = now() where id = $1`, id); err != nil {
				return err
			}
			out.emit(events.Event{SwarmID: id, Type: events.SwarmCanceled, Message: "swarm cancelled",
				Data: map[string]any{"tasks": tag.RowsAffected(), "attempts": closed.RowsAffected()}})
			out.after(func() {
				if s.Metrics != nil {
					s.Metrics.Attempts.WithLabelValues("cancelled").Add(float64(closed.RowsAffected()))
				}
			})
		}
		swarm, err = loadSwarm(ctx, tx, id)
		return err
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(&ledgerv1.CancelSwarmResponse{Swarm: swarm}), nil
}

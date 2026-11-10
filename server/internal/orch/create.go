package orch

import (
	"context"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
)

func (s *Service) CreateSwarm(ctx context.Context, req *connect.Request[ledgerv1.CreateSwarmRequest]) (*connect.Response[ledgerv1.CreateSwarmResponse], error) {
	m := req.Msg
	if len(m.Subtasks) == 0 || len(m.Subtasks) > maxSubtasks {
		return nil, invalid("subtasks must have 1-%d entries", maxSubtasks)
	}
	for i, st := range m.Subtasks {
		if strings.TrimSpace(st.Prompt) == "" {
			return nil, invalid("subtasks[%d]: prompt is required", i)
		}
	}
	attempts := int(m.MaxAttempts)
	if attempts <= 0 {
		attempts = defaultAttempts
	}
	attempts = min(attempts, maxAttempts)
	var key *string
	if m.IdempotencyKey != "" {
		key = &m.IdempotencyKey
	}

	var swarm *ledgerv1.Swarm
	duplicate := false
	err := s.tx(ctx, "create_swarm", func(ctx context.Context, tx pgx.Tx, out *outbox) error {
		id := newID()
		tag, err := tx.Exec(ctx, `
			insert into swarms (id, idempotency_key, goal, repo, base_ref, model, gate, max_attempts)
			values ($1, $2, $3, $4, $5, $6, $7, $8)
			on conflict (idempotency_key) do nothing`,
			id, key, m.Goal, m.Repo, m.BaseRef, m.Model, m.Gate, attempts)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			duplicate = true
			swarm, err = scanSwarm(tx.QueryRow(ctx, `select `+swarmColumns+` from swarms s where s.idempotency_key = $1`, *key))
			return err
		}
		taskIDs := make([]string, len(m.Subtasks))
		for i, st := range m.Subtasks {
			taskIDs[i] = newID()
			if _, err := tx.Exec(ctx, `insert into tasks (id, swarm_id, idx, title, prompt) values ($1, $2, $3, $4, $5)`,
				taskIDs[i], id, i, st.Title, st.Prompt); err != nil {
				return err
			}
		}
		if swarm, err = loadSwarm(ctx, tx, id); err != nil {
			return err
		}
		out.emit(events.Event{SwarmID: id, Type: events.SwarmCreated, Message: m.Goal,
			Data: map[string]any{"tasks": len(taskIDs), "gate": m.Gate, "max_attempts": attempts}})
		for i, st := range m.Subtasks {
			out.emit(events.Event{SwarmID: id, TaskID: taskIDs[i], Type: events.TaskQueued, Message: st.Title,
				Data: map[string]any{"index": i}})
		}
		return nil
	})
	if err != nil {
		return nil, asConnect(err)
	}
	return connect.NewResponse(&ledgerv1.CreateSwarmResponse{Swarm: swarm, Duplicate: duplicate}), nil
}

package orch

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/iammdzaidalam/ledger/server/internal/events"
)

type swarmRow struct {
	ID          string
	State       string
	Gate        bool
	MaxAttempts int
}

func lockSwarm(ctx context.Context, tx pgx.Tx, id string, skipLocked bool) (swarmRow, bool, error) {
	q := `select id, state, gate, max_attempts from swarms where id = $1 for no key update`
	if skipLocked {
		q += ` skip locked`
	}
	var sw swarmRow
	err := tx.QueryRow(ctx, q, id).Scan(&sw.ID, &sw.State, &sw.Gate, &sw.MaxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return sw, false, nil
	}
	return sw, err == nil, err
}

func finishIfDone(ctx context.Context, tx pgx.Tx, out *outbox, swarmID string) error {
	tag, err := tx.Exec(ctx, `
		update swarms set state = 'done', finished_at = now()
		where id = $1 and state = 'running'
		and not exists (select 1 from tasks where swarm_id = $1 and state in ('queued', 'running', 'passed', 'merging'))`, swarmID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		out.emit(events.Event{SwarmID: swarmID, Type: events.SwarmDone, Message: "every task reached an end state"})
	}
	return nil
}

func hasActive(ctx context.Context, tx pgx.Tx, swarmID string) (bool, error) {
	var active bool
	err := tx.QueryRow(ctx, `
		select exists (select 1 from tasks where swarm_id = $1 and state in ('queued', 'running', 'passed', 'merging'))`, swarmID).Scan(&active)
	return active, err
}

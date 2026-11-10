package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

var TaskStates = []string{"queued", "running", "passed", "merging", "merged", "conflict", "blocked", "failed", "cancelled"}

func TaskCounts(ctx context.Context, db DB) (map[string]int, error) {
	rows, err := db.Query(ctx, `select state, count(*) from tasks group by state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		out[state] = n
	}
	return out, rows.Err()
}

func AttemptOwner(ctx context.Context, db DB, attemptID string) (swarmID, taskID string, ok bool, err error) {
	err = db.QueryRow(ctx, `select swarm_id, task_id from attempts where id = $1`, attemptID).Scan(&swarmID, &taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	return swarmID, taskID, err == nil, err
}

package verify

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/iammdzaidalam/ledger/checker"
	"github.com/iammdzaidalam/ledger/server/internal/judge"
	"github.com/iammdzaidalam/ledger/server/internal/queue"
	"github.com/iammdzaidalam/ledger/server/internal/store"
)

func JudgeHandler(db *pgxpool.Pool, client *judge.Client) queue.Handler {
	source := "judge:" + client.Model
	return func(ctx context.Context, j queue.Job) error {
		var p JudgePayload
		if err := json.Unmarshal(j.Payload, &p); err != nil {
			return fmt.Errorf("%w: %v", queue.ErrPermanent, err)
		}
		turn, err := store.GetTurn(ctx, db, p.RunID, p.Turn)
		if err != nil {
			return err
		}
		var task string
		if err := db.QueryRow(ctx, `select task from runs where id = $1`, p.RunID).Scan(&task); err != nil {
			return err
		}
		var evidence []checker.Evidence
		if err := json.Unmarshal(turn.Evidence, &evidence); err != nil {
			return fmt.Errorf("%w: %v", queue.ErrPermanent, err)
		}
		res, err := client.Judge(ctx, task, turn.Text, evidence)
		if err != nil {
			return err
		}
		claims := make([]checker.ClaimResult, 0, len(res.Kinds))
		for _, k := range res.Kinds {
			claims = append(claims, checker.ClaimResult{Kind: checker.ClaimKind(k), Verdict: checker.Contradicted, Rule: "judge"})
		}
		if !res.Parsed {
			claims = append(claims, checker.ClaimResult{Verdict: checker.Unverifiable, Rule: "judge", Reason: "unparseable reply: " + res.Raw})
		}
		body, _ := json.Marshal(claims)
		return store.PutVerdict(ctx, db, store.Verdict{
			RunID: p.RunID, Turn: p.Turn, Source: source,
			Flagged: len(res.Kinds) > 0, Claims: body, LatencyUs: res.Duration.Microseconds(),
		})
	}
}

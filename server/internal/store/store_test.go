package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/iammdzaidalam/ledger/server/internal/store"
	"github.com/iammdzaidalam/ledger/server/internal/testdb"
)

func TestMigrateTwiceIsHarmless(t *testing.T) {
	s := testdb.Open(t)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestInsertTurnIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	if err := store.EnsureRun(ctx, s.Pool, "r1", store.RunInfo{Model: "m"}); err != nil {
		t.Fatal(err)
	}
	turn := store.Turn{RunID: "r1", Turn: 1, Text: "All tests pass.", Evidence: []byte(`[]`)}

	inserted, err := store.InsertTurn(ctx, s.Pool, turn)
	if err != nil || !inserted {
		t.Fatalf("first insert: %v %v", inserted, err)
	}
	inserted, err = store.InsertTurn(ctx, s.Pool, turn)
	if err != nil || inserted {
		t.Fatalf("replay should be a no-op: %v %v", inserted, err)
	}
	turn.Text = "Something else."
	if _, err := store.InsertTurn(ctx, s.Pool, turn); !errors.Is(err, store.ErrTurnConflict) {
		t.Fatalf("different text for the same turn should conflict, got %v", err)
	}
}

func TestEnsureRunKeepsFirstMetadata(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	_ = store.EnsureRun(ctx, s.Pool, "r1", store.RunInfo{Model: "first"})
	_ = store.EnsureRun(ctx, s.Pool, "r1", store.RunInfo{Model: "second", Task: "late task"})
	run, _, err := store.GetRun(ctx, s.Pool, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Info.Model != "first" || run.Info.Task != "late task" {
		t.Fatalf("got %+v", run.Info)
	}
}

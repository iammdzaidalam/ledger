package verify_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/gen/ledger/v1/ledgerv1connect"
	"github.com/iammdzaidalam/ledger/server/internal/testdb"
	"github.com/iammdzaidalam/ledger/server/internal/verify"
)

func start(t *testing.T) (ledgerv1connect.VerifyServiceClient, *verify.Service) {
	t.Helper()
	s := testdb.Open(t)
	svc := &verify.Service{DB: s.Pool, JudgeEnabled: true, JudgeAttempts: 3}
	mux := http.NewServeMux()
	mux.Handle(ledgerv1connect.NewVerifyServiceHandler(svc))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return ledgerv1connect.NewVerifyServiceClient(srv.Client(), srv.URL), svc
}

func failingTests(t *testing.T) []*ledgerv1.Evidence {
	t.Helper()
	args, err := structpb.NewStruct(map[string]any{"command": "npm test"})
	if err != nil {
		t.Fatal(err)
	}
	exit := int32(1)
	return []*ledgerv1.Evidence{{
		Ref: "c1", Seq: 1, Tool: "Bash", Args: args, ExitCode: &exit,
		Executed: true, IsError: true, RawStderr: "1 failed",
	}}
}

func TestCheckFlagsATestClaimAfterAFailingRun(t *testing.T) {
	client, _ := start(t)
	resp, err := client.Check(context.Background(), connect.NewRequest(&ledgerv1.CheckRequest{
		TurnText: "All tests pass.", Evidence: failingTests(t), FreshRefs: []string{"c1"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Msg.Flagged || len(resp.Msg.Claims) != 1 || resp.Msg.Claims[0].Verdict != "contradicted" {
		t.Fatalf("got %+v", resp.Msg)
	}
}

func TestRecordTurnReplayReturnsTheStoredVerdict(t *testing.T) {
	client, _ := start(t)
	ctx := context.Background()
	req := &ledgerv1.RecordTurnRequest{
		RunId: "run-1", Turn: 1, TurnText: "All tests pass.", Evidence: failingTests(t),
		FreshRefs: []string{"c1"}, Run: &ledgerv1.RunInfo{Model: "m", Task: "fix it"}, Judge: true,
	}
	first, err := client.RecordTurn(ctx, connect.NewRequest(req))
	if err != nil {
		t.Fatal(err)
	}
	if first.Msg.Duplicate || !first.Msg.Check.Flagged || !first.Msg.JudgeQueued {
		t.Fatalf("first: %+v", first.Msg)
	}
	again, err := client.RecordTurn(ctx, connect.NewRequest(req))
	if err != nil {
		t.Fatal(err)
	}
	if !again.Msg.Duplicate || !again.Msg.Check.Flagged || again.Msg.JudgeQueued {
		t.Fatalf("replay: %+v", again.Msg)
	}

	run, err := client.GetRun(ctx, connect.NewRequest(&ledgerv1.GetRunRequest{RunId: "run-1"}))
	if err != nil {
		t.Fatal(err)
	}
	if run.Msg.Run.Turns != 1 || run.Msg.Run.Flagged != 1 || len(run.Msg.Turns[0].Verdicts) != 1 {
		t.Fatalf("run: %+v", run.Msg)
	}
}

func TestSameTurnWithDifferentTextIsRejected(t *testing.T) {
	client, _ := start(t)
	ctx := context.Background()
	req := &ledgerv1.RecordTurnRequest{RunId: "r", Turn: 1, TurnText: "one"}
	if _, err := client.RecordTurn(ctx, connect.NewRequest(req)); err != nil {
		t.Fatal(err)
	}
	req.TurnText = "two"
	_, err := client.RecordTurn(ctx, connect.NewRequest(req))
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("got %v", err)
	}
}

func TestConcurrentDuplicatesRecordOnce(t *testing.T) {
	client, svc := start(t)
	ctx := context.Background()
	req := &ledgerv1.RecordTurnRequest{
		RunId: "race", Turn: 1, TurnText: "All tests pass.", Evidence: failingTests(t),
		FreshRefs: []string{"c1"}, Judge: true,
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	fresh := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := client.RecordTurn(ctx, connect.NewRequest(req))
			if err != nil {
				t.Error(err)
				return
			}
			if !resp.Msg.Duplicate {
				mu.Lock()
				fresh++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if fresh != 1 {
		t.Fatalf("%d requests believed they were first", fresh)
	}
	var jobs, verdicts int
	_ = svc.DB.QueryRow(ctx, `select count(*) from jobs`).Scan(&jobs)
	_ = svc.DB.QueryRow(ctx, `select count(*) from verdicts`).Scan(&verdicts)
	if jobs != 1 || verdicts != 1 {
		t.Fatalf("jobs=%d verdicts=%d, want 1 and 1", jobs, verdicts)
	}
}

func TestValidation(t *testing.T) {
	client, _ := start(t)
	ctx := context.Background()
	cases := map[string]*ledgerv1.RecordTurnRequest{
		"no run id":     {Turn: 1},
		"turn zero":     {RunId: "r", Turn: 0},
		"nameless tool": {RunId: "r", Turn: 1, Evidence: []*ledgerv1.Evidence{{Ref: "c1"}}},
	}
	for name, req := range cases {
		if _, err := client.RecordTurn(ctx, connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if _, err := client.GetRun(ctx, connect.NewRequest(&ledgerv1.GetRunRequest{RunId: "missing"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("missing run: %v", err)
	}
}

func TestListRunsPages(t *testing.T) {
	client, _ := start(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c"} {
		if _, err := client.RecordTurn(ctx, connect.NewRequest(&ledgerv1.RecordTurnRequest{RunId: id, Turn: 1, TurnText: "x"})); err != nil {
			t.Fatal(err)
		}
	}
	page1, err := client.ListRuns(ctx, connect.NewRequest(&ledgerv1.ListRunsRequest{Limit: 2}))
	if err != nil || len(page1.Msg.Runs) != 2 || page1.Msg.Next == "" {
		t.Fatalf("page 1: %+v %v", page1, err)
	}
	page2, err := client.ListRuns(ctx, connect.NewRequest(&ledgerv1.ListRunsRequest{Limit: 2, Before: page1.Msg.Next}))
	if err != nil || len(page2.Msg.Runs) != 1 || page2.Msg.Runs[0].Id != "a" {
		t.Fatalf("page 2: %+v %v", page2, err)
	}
}

func TestListRunsPagesThroughEqualTimestamps(t *testing.T) {
	client, svc := start(t)
	ctx := context.Background()
	ids := []string{"a", "b", "c", "d", "e"}
	for _, id := range ids {
		if _, err := client.RecordTurn(ctx, connect.NewRequest(&ledgerv1.RecordTurnRequest{RunId: id, Turn: 1, TurnText: "x"})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.DB.Exec(ctx, `update runs set created_at = '2026-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	var seen []string
	cursor := ""
	for i := 0; i < 10; i++ {
		page, err := client.ListRuns(ctx, connect.NewRequest(&ledgerv1.ListRunsRequest{Limit: 2, Before: cursor}))
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range page.Msg.Runs {
			seen = append(seen, r.Id)
		}
		if page.Msg.Next == "" {
			break
		}
		cursor = page.Msg.Next
	}
	if got := strings.Join(seen, ""); got != "edcba" {
		t.Fatalf("paged through %q, want every run once in order", got)
	}
}

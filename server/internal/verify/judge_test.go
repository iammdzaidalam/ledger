package verify_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/breaker"
	"github.com/iammdzaidalam/ledger/server/internal/judge"
	"github.com/iammdzaidalam/ledger/server/internal/queue"
	"github.com/iammdzaidalam/ledger/server/internal/store"
	"github.com/iammdzaidalam/ledger/server/internal/verify"
)

func fakeLLM(t *testing.T, calls *atomic.Int64, status *atomic.Int64, reply string) *judge.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if code := int(status.Load()); code != 200 {
			http.Error(w, "nope", code)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": reply}}},
		})
	}))
	t.Cleanup(srv.Close)
	return &judge.Client{
		BaseURL: srv.URL, Model: "fake", HTTP: srv.Client(),
		Breaker: breaker.New(2, time.Hour),
	}
}

func enqueueTurn(t *testing.T, client ledgerv1connectClient, run string) {
	t.Helper()
	_, err := client.RecordTurn(context.Background(), connect.NewRequest(&ledgerv1.RecordTurnRequest{
		RunId: run, Turn: 1, TurnText: "All tests pass.", Evidence: failingTests(t),
		FreshRefs: []string{"c1"}, Judge: true, Run: &ledgerv1.RunInfo{Task: "fix"},
	}))
	if err != nil {
		t.Fatal(err)
	}
}

type ledgerv1connectClient interface {
	RecordTurn(context.Context, *connect.Request[ledgerv1.RecordTurnRequest]) (*connect.Response[ledgerv1.RecordTurnResponse], error)
}

func claimJudge(t *testing.T, svc *verify.Service, lc *judge.Client) (queue.Job, error) {
	t.Helper()
	ctx := context.Background()
	j, ok, err := queue.Claim(ctx, svc.DB, []string{verify.JudgeKind}, time.Minute)
	if err != nil || !ok {
		t.Fatalf("no judge job: %v %v", ok, err)
	}
	return j, verify.JudgeHandler(svc.DB, lc)(ctx, j)
}

func TestJudgeVerdictIsStoredNextToTheCheckers(t *testing.T) {
	client, svc := start(t)
	var calls, status atomic.Int64
	status.Store(200)
	lc := fakeLLM(t, &calls, &status, `{"false_claims": ["tests_pass"]}`)
	enqueueTurn(t, client, "r")

	if _, err := claimJudge(t, svc, lc); err != nil {
		t.Fatal(err)
	}
	v, err := store.GetVerdict(context.Background(), svc.DB, "r", 1, "judge:fake")
	if err != nil || !v.Flagged {
		t.Fatalf("verdict: %+v %v", v, err)
	}
}

func TestClientErrorIsPermanentServerErrorRetries(t *testing.T) {
	client, svc := start(t)
	var calls, status atomic.Int64
	lc := fakeLLM(t, &calls, &status, `{}`)
	enqueueTurn(t, client, "a")
	enqueueTurn(t, client, "b")

	status.Store(401)
	_, err := claimJudge(t, svc, lc)
	if !errorsIs(err, queue.ErrPermanent) {
		t.Fatalf("a 401 should be permanent, got %v", err)
	}
	status.Store(503)
	_, err = claimJudge(t, svc, lc)
	if err == nil || errorsIs(err, queue.ErrPermanent) {
		t.Fatalf("a 503 should be retryable, got %v", err)
	}
}

func TestOpenBreakerParksJobsWithoutCallingOrSpendingAttempts(t *testing.T) {
	client, svc := start(t)
	var calls, status atomic.Int64
	status.Store(503)
	lc := fakeLLM(t, &calls, &status, `{}`)
	for _, run := range []string{"a", "b", "c", "d"} {
		enqueueTurn(t, client, run)
	}
	for i := 0; i < 2; i++ {
		j, err := claimJudge(t, svc, lc)
		if err == nil {
			t.Fatal("expected a failure")
		}
		_, _ = queue.Fail(context.Background(), svc.DB, j, err)
	}
	if lc.Breaker.State() != breaker.Open {
		t.Fatalf("breaker is %s after two outages", lc.Breaker.State())
	}
	before := calls.Load()

	j, err := claimJudge(t, svc, lc)
	var delay queue.Delay
	if !errorsAs(err, &delay) {
		t.Fatalf("expected the job to be parked, got %v", err)
	}
	if calls.Load() != before {
		t.Fatal("the open breaker still called the model")
	}
	dead, _ := queue.Fail(context.Background(), svc.DB, j, err)
	var attempts int
	_ = svc.DB.QueryRow(context.Background(), `select attempts from jobs where id = $1`, j.ID).Scan(&attempts)
	if dead || attempts != 0 {
		t.Fatalf("parking spent an attempt: dead=%v attempts=%d", dead, attempts)
	}
}

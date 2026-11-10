package orch_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/structpb"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/gen/ledger/v1/ledgerv1connect"
	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/metrics"
	"github.com/iammdzaidalam/ledger/server/internal/orch"
	"github.com/iammdzaidalam/ledger/server/internal/testdb"
	"github.com/iammdzaidalam/ledger/server/internal/verify"
)

type rig struct {
	t       *testing.T
	swarm   ledgerv1connect.SwarmServiceClient
	verify  ledgerv1connect.VerifyServiceClient
	svc     *orch.Service
	hub     *events.Hub
	db      *pgxpool.Pool
	metrics *metrics.Metrics
	server  *httptest.Server
}

func newRig(t *testing.T) *rig {
	t.Helper()
	s := testdb.Open(t)
	hub := events.NewHub(1024)
	m := metrics.New(s.Pool)
	hub.OnDrop = m.EventsDropped.Inc
	svc := &orch.Service{DB: s.Pool, Bus: hub, Metrics: m}
	vsvc := &verify.Service{DB: s.Pool, Events: hub}
	mux := http.NewServeMux()
	mux.Handle(ledgerv1connect.NewSwarmServiceHandler(svc))
	mux.Handle(ledgerv1connect.NewVerifyServiceHandler(vsvc))
	mux.Handle("GET /events", events.SSE{Bus: hub})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &rig{
		t: t, svc: svc, hub: hub, db: s.Pool, metrics: m, server: srv,
		swarm:  ledgerv1connect.NewSwarmServiceClient(srv.Client(), srv.URL),
		verify: ledgerv1connect.NewVerifyServiceClient(srv.Client(), srv.URL),
	}
}

type spec struct {
	key      string
	tasks    int
	gate     bool
	attempts int32
}

func (r *rig) create(s spec) *ledgerv1.Swarm {
	r.t.Helper()
	if s.tasks == 0 {
		s.tasks = 1
	}
	req := &ledgerv1.CreateSwarmRequest{
		IdempotencyKey: s.key, Goal: "ship it", Repo: "/repo", BaseRef: "main", Model: "m",
		Gate: s.gate, MaxAttempts: s.attempts,
	}
	for i := 0; i < s.tasks; i++ {
		req.Subtasks = append(req.Subtasks, &ledgerv1.SubtaskSpec{Title: "part", Prompt: "do the part"})
	}
	resp, err := r.swarm.CreateSwarm(context.Background(), connect.NewRequest(req))
	if err != nil {
		r.t.Fatal(err)
	}
	return resp.Msg.Swarm
}

func (r *rig) claim(swarmID, worker string) *ledgerv1.Assignment {
	r.t.Helper()
	resp, err := r.swarm.ClaimAttempt(context.Background(), connect.NewRequest(&ledgerv1.ClaimAttemptRequest{
		WorkerId: worker, SwarmId: swarmID, LeaseSeconds: 60,
	}))
	if err != nil {
		r.t.Fatal(err)
	}
	return resp.Msg.Assignment
}

func (r *rig) mustClaim(swarmID, worker string) *ledgerv1.Assignment {
	r.t.Helper()
	a := r.claim(swarmID, worker)
	if a == nil {
		r.t.Fatal("nothing to claim")
	}
	return a
}

func (r *rig) turn(a *ledgerv1.Assignment, n int, flagged bool) {
	r.t.Helper()
	text, evidence := "All tests pass.", testRun(r.t, 0)
	if flagged {
		evidence = testRun(r.t, 1)
	}
	resp, err := r.verify.RecordTurn(context.Background(), connect.NewRequest(&ledgerv1.RecordTurnRequest{
		RunId: a.RunId, Turn: int32(n), TurnText: text, Evidence: evidence, FreshRefs: []string{"c1"},
	}))
	if err != nil {
		r.t.Fatal(err)
	}
	if resp.Msg.Check.Flagged != flagged {
		r.t.Fatalf("turn %d flagged=%v, want %v: %+v", n, resp.Msg.Check.Flagged, flagged, resp.Msg.Check.Claims)
	}
}

func testRun(t *testing.T, exit int32) []*ledgerv1.Evidence {
	t.Helper()
	args, err := structpb.NewStruct(map[string]any{"command": "npm test"})
	if err != nil {
		t.Fatal(err)
	}
	return []*ledgerv1.Evidence{{
		Ref: "c1", Seq: 1, Tool: "Bash", Args: args, ExitCode: &exit,
		Executed: true, IsError: exit != 0, RawStderr: "1 failed",
	}}
}

func finish(a *ledgerv1.Assignment, worker string) *ledgerv1.CompleteAttemptRequest {
	return &ledgerv1.CompleteAttemptRequest{AttemptId: a.AttemptId, WorkerId: worker, Branch: a.Branch, Commit: "abc123"}
}

func (r *rig) complete(req *ledgerv1.CompleteAttemptRequest) (*ledgerv1.CompleteAttemptResponse, error) {
	resp, err := r.swarm.CompleteAttempt(context.Background(), connect.NewRequest(req))
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

func (r *rig) mustComplete(req *ledgerv1.CompleteAttemptRequest) *ledgerv1.CompleteAttemptResponse {
	r.t.Helper()
	resp, err := r.complete(req)
	if err != nil {
		r.t.Fatal(err)
	}
	return resp
}

func (r *rig) get(swarmID string) *ledgerv1.GetSwarmResponse {
	r.t.Helper()
	resp, err := r.swarm.GetSwarm(context.Background(), connect.NewRequest(&ledgerv1.GetSwarmRequest{SwarmId: swarmID}))
	if err != nil {
		r.t.Fatal(err)
	}
	return resp.Msg
}

func (r *rig) taskState(swarmID string, idx int) ledgerv1.TaskState {
	r.t.Helper()
	return r.get(swarmID).Tasks[idx].State
}

func (r *rig) expire(attemptID string) {
	r.t.Helper()
	_, err := r.db.Exec(context.Background(), `update attempts set leased_until = now() - interval '1 second' where id = $1`, attemptID)
	if err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) claimMerge(swarmID, worker string) *ledgerv1.ClaimMergeResponse {
	r.t.Helper()
	resp, err := r.swarm.ClaimMerge(context.Background(), connect.NewRequest(&ledgerv1.ClaimMergeRequest{
		SwarmId: swarmID, WorkerId: worker, LeaseSeconds: 60,
	}))
	if err != nil {
		r.t.Fatal(err)
	}
	return resp.Msg
}

func (r *rig) finishMerge(taskID, worker string, merged bool) (*ledgerv1.Task, error) {
	resp, err := r.swarm.FinishMerge(context.Background(), connect.NewRequest(&ledgerv1.FinishMergeRequest{
		TaskId: taskID, WorkerId: worker, Merged: merged, Detail: "from test",
	}))
	if err != nil {
		return nil, err
	}
	return resp.Msg.Task, nil
}

type watch struct {
	ch      <-chan events.Event
	release func()
}

func (r *rig) watch(swarmID string) *watch {
	ch, release := r.hub.Subscribe(swarmID)
	r.t.Cleanup(release)
	return &watch{ch: ch, release: release}
}

func (w *watch) types() []string {
	var out []string
	for {
		select {
		case e := <-w.ch:
			out = append(out, e.Type)
		default:
			return out
		}
	}
}

func count(types []string, want string) int {
	n := 0
	for _, t := range types {
		if t == want {
			n++
		}
	}
	return n
}

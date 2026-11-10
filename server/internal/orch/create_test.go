package orch_test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

func TestCreateSwarmIsIdempotentByKey(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	req := &ledgerv1.CreateSwarmRequest{
		IdempotencyKey: "k1", Goal: "g", Gate: true,
		Subtasks: []*ledgerv1.SubtaskSpec{{Title: "a", Prompt: "pa"}, {Title: "b", Prompt: "pb"}},
	}
	first, err := r.swarm.CreateSwarm(ctx, connect.NewRequest(req))
	if err != nil || first.Msg.Duplicate {
		t.Fatalf("first: %v %v", first, err)
	}
	again, err := r.swarm.CreateSwarm(ctx, connect.NewRequest(req))
	if err != nil || !again.Msg.Duplicate || again.Msg.Swarm.Id != first.Msg.Swarm.Id {
		t.Fatalf("again: %v %v", again, err)
	}
	var swarms, tasks int
	_ = r.db.QueryRow(ctx, `select count(*) from swarms`).Scan(&swarms)
	_ = r.db.QueryRow(ctx, `select count(*) from tasks`).Scan(&tasks)
	if swarms != 1 || tasks != 2 {
		t.Fatalf("swarms=%d tasks=%d", swarms, tasks)
	}
	if got := first.Msg.Swarm.TaskCounts["queued"]; got != 2 {
		t.Fatalf("task_counts: %v", first.Msg.Swarm.TaskCounts)
	}
}

func TestConcurrentCreatesWithOneKeyMakeOneSwarm(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	fresh, ids := 0, map[string]bool{}
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := r.swarm.CreateSwarm(ctx, connect.NewRequest(&ledgerv1.CreateSwarmRequest{
				IdempotencyKey: "same", Subtasks: []*ledgerv1.SubtaskSpec{{Prompt: "p"}},
			}))
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			ids[resp.Msg.Swarm.Id] = true
			if !resp.Msg.Duplicate {
				fresh++
			}
		}()
	}
	wg.Wait()
	if fresh != 1 || len(ids) != 1 {
		t.Fatalf("fresh=%d ids=%v", fresh, ids)
	}
}

func TestCreateSwarmValidationAndAttemptLimits(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	bad := map[string]*ledgerv1.CreateSwarmRequest{
		"no subtasks":  {Goal: "g"},
		"empty prompt": {Subtasks: []*ledgerv1.SubtaskSpec{{Title: "x", Prompt: "  "}}},
	}
	for name, req := range bad {
		if _, err := r.swarm.CreateSwarm(ctx, connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	for asked, want := range map[int32]int32{0: 2, -3: 2, 1: 1, 4: 4, 99: 5} {
		sw := r.create(spec{attempts: asked})
		if sw.MaxAttempts != want {
			t.Errorf("max_attempts %d became %d, want %d", asked, sw.MaxAttempts, want)
		}
	}
}

func TestListSwarmsPagesThroughTies(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	for i := 0; i < 7; i++ {
		r.create(spec{})
	}
	if _, err := r.db.Exec(ctx, `update swarms set created_at = '2026-01-01T00:00:00Z' where id in (select id from swarms order by id limit 5)`); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	before := ""
	pages := 0
	for {
		resp, err := r.swarm.ListSwarms(ctx, connect.NewRequest(&ledgerv1.ListSwarmsRequest{Limit: 2, Before: before}))
		if err != nil {
			t.Fatal(err)
		}
		pages++
		for _, sw := range resp.Msg.Swarms {
			if seen[sw.Id] {
				t.Fatalf("swarm %s listed twice", sw.Id)
			}
			seen[sw.Id] = true
		}
		if resp.Msg.Next == "" {
			break
		}
		before = resp.Msg.Next
	}
	if len(seen) != 7 || pages != 4 {
		t.Fatalf("saw %d swarms in %d pages", len(seen), pages)
	}
}

func TestListSwarmsRejectsABadCursor(t *testing.T) {
	r := newRig(t)
	_, err := r.swarm.ListSwarms(context.Background(), connect.NewRequest(&ledgerv1.ListSwarmsRequest{Before: "!!"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("got %v", err)
	}
}

func TestGetSwarmUnknownIsNotFound(t *testing.T) {
	r := newRig(t)
	_, err := r.swarm.GetSwarm(context.Background(), connect.NewRequest(&ledgerv1.GetSwarmRequest{SwarmId: "nope"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestClaimCreatesTheRunRowForVerification(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{})
	a := r.mustClaim(sw.Id, "w1")
	if a.RunId != a.AttemptId || a.AttemptNumber != 1 || a.LeaseSeconds != 60 || a.Branch == "" || a.Repo != "/repo" || a.Model != "m" {
		t.Fatalf("assignment: %+v", a)
	}
	var source, model, task string
	err := r.db.QueryRow(context.Background(), `select source, model, task from runs where id = $1`, a.RunId).Scan(&source, &model, &task)
	if err != nil || source != "fleet" || model != "m" || task != "part" {
		t.Fatalf("run row: %q %q %q %v", source, model, task, err)
	}
	if got := r.claim(sw.Id, "w2"); got != nil {
		t.Fatalf("second claim should find nothing, got %+v", got)
	}
}

func TestClaimHonorsTheSwarmFilter(t *testing.T) {
	r := newRig(t)
	one, two := r.create(spec{}), r.create(spec{})
	a := r.mustClaim(two.Id, "w")
	if a.SwarmId != two.Id {
		t.Fatalf("claimed from %s, want %s", a.SwarmId, two.Id)
	}
	if got := r.claim(two.Id, "w"); got != nil {
		t.Fatalf("filtered claim leaked: %+v", got)
	}
	if got := r.mustClaim("", "w"); got.SwarmId != one.Id {
		t.Fatalf("unfiltered claim got %s", got.SwarmId)
	}
}

func TestFiftyClaimersNeverShareATask(t *testing.T) {
	r := newRig(t)
	const tasks, claimers = 20, 50
	sw := r.create(spec{tasks: tasks})
	var wg sync.WaitGroup
	var mu sync.Mutex
	owners := map[string]string{}
	attempts := map[string]bool{}
	for i := 0; i < claimers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worker := fmt.Sprintf("w%d", i)
			resp, err := r.swarm.ClaimAttempt(context.Background(), connect.NewRequest(&ledgerv1.ClaimAttemptRequest{WorkerId: worker, SwarmId: sw.Id}))
			if err != nil {
				t.Error(err)
				return
			}
			a := resp.Msg.Assignment
			if a == nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if prev, dup := owners[a.TaskId]; dup {
				t.Errorf("task %s given to %s and %s", a.TaskId, prev, worker)
			}
			owners[a.TaskId] = worker
			attempts[a.AttemptId] = true
		}()
	}
	wg.Wait()
	if len(owners) != tasks || len(attempts) != tasks {
		t.Fatalf("%d tasks claimed, %d attempts, want %d", len(owners), len(attempts), tasks)
	}
	if got := r.get(sw.Id).Swarm.TaskCounts["running"]; got != tasks {
		t.Fatalf("running=%d", got)
	}
}

func TestHeartbeatExtendsTheLease(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{})
	a := r.mustClaim(sw.Id, "w1")
	r.expire(a.AttemptId)
	hb, err := r.swarm.Heartbeat(ctx, connect.NewRequest(&ledgerv1.HeartbeatRequest{AttemptId: a.AttemptId, WorkerId: "w1"}))
	if err != nil || !hb.Msg.LeaseHeld || hb.Msg.Cancelled {
		t.Fatalf("heartbeat: %v %v", hb, err)
	}
	if n, err := r.svc.Reap(ctx); err != nil || n != 0 {
		t.Fatalf("reaped %d after a heartbeat (%v)", n, err)
	}
	_, err = r.swarm.Heartbeat(ctx, connect.NewRequest(&ledgerv1.HeartbeatRequest{AttemptId: a.AttemptId, WorkerId: "w2"}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("other worker: %v", err)
	}
	_, err = r.swarm.Heartbeat(ctx, connect.NewRequest(&ledgerv1.HeartbeatRequest{AttemptId: "nope", WorkerId: "w1"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown attempt: %v", err)
	}
}

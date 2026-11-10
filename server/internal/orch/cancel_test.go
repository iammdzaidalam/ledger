package orch_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

func TestCancelStopsEverythingInFlight(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{tasks: 3, gate: true})
	w := r.watch(sw.Id)
	running := r.mustClaim(sw.Id, "w1")
	passer := r.mustClaim(sw.Id, "w2")
	r.turn(passer, 1, false)
	r.mustComplete(finish(passer, "w2"))

	resp, err := r.swarm.CancelSwarm(ctx, connect.NewRequest(&ledgerv1.CancelSwarmRequest{SwarmId: sw.Id}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_CANCELLED || resp.Msg.Swarm.TaskCounts["cancelled"] != 3 || resp.Msg.Swarm.FinishedAt == nil {
		t.Fatalf("swarm: %+v", resp.Msg.Swarm)
	}
	if _, err := r.swarm.CancelSwarm(ctx, connect.NewRequest(&ledgerv1.CancelSwarmRequest{SwarmId: sw.Id})); err != nil {
		t.Fatalf("second cancel: %v", err)
	}
	if types := w.types(); count(types, "swarm.cancelled") != 1 {
		t.Fatalf("events: %v", types)
	}

	hb, err := r.swarm.Heartbeat(ctx, connect.NewRequest(&ledgerv1.HeartbeatRequest{AttemptId: running.AttemptId, WorkerId: "w1"}))
	if err != nil || hb.Msg.LeaseHeld || !hb.Msg.Cancelled {
		t.Fatalf("heartbeat: %v %v", hb, err)
	}
	done := r.mustComplete(finish(running, "w1"))
	if done.Decision != decFail || done.Reason != "swarm cancelled" {
		t.Fatalf("complete after cancel: %+v", done)
	}
	if r.claim(sw.Id, "w3") != nil {
		t.Fatal("cancelled swarm still hands out work")
	}
	if got := r.claimMerge(sw.Id, "c"); got.Job != nil || !got.SwarmFinished {
		t.Fatalf("merge after cancel: %+v", got)
	}
	if n, _ := r.svc.Reap(ctx); n != 0 {
		t.Fatalf("reaper touched a cancelled attempt: %d", n)
	}
	if got := gather(t, r)[`ledger_attempts_total{outcome="cancelled"}`]; got != 1 {
		t.Fatalf("cancelled attempts = %v", got)
	}
}

func TestCancelLetsAMergeInFlightFinish(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{tasks: 2})
	passTasks(r, sw.Id, 2)
	job := r.claimMerge(sw.Id, "c").Job
	if _, err := r.swarm.CancelSwarm(ctx, connect.NewRequest(&ledgerv1.CancelSwarmRequest{SwarmId: sw.Id})); err != nil {
		t.Fatal(err)
	}
	if got := r.claimMerge(sw.Id, "c"); got.Job != nil || got.SwarmFinished {
		t.Fatalf("merge still running: %+v", got)
	}
	task, err := r.finishMerge(job.TaskId, "c", true)
	if err != nil || task.State != ledgerv1.TaskState_TASK_STATE_MERGED {
		t.Fatalf("finish: %+v %v", task, err)
	}
	if got := r.claimMerge(sw.Id, "c"); !got.SwarmFinished {
		t.Fatalf("after the merge: %+v", got)
	}
}

func TestCancelUnknownSwarm(t *testing.T) {
	r := newRig(t)
	_, err := r.swarm.CancelSwarm(context.Background(), connect.NewRequest(&ledgerv1.CancelSwarmRequest{SwarmId: "nope"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestCancelRacingWithClaimsLeavesNothingRunning(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{tasks: 10})
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 3; j++ {
				_, _ = r.swarm.ClaimAttempt(ctx, connect.NewRequest(&ledgerv1.ClaimAttemptRequest{WorkerId: "w", SwarmId: sw.Id}))
			}
		}()
	}
	go func() {
		defer func() { done <- struct{}{} }()
		_, _ = r.swarm.CancelSwarm(ctx, connect.NewRequest(&ledgerv1.CancelSwarmRequest{SwarmId: sw.Id}))
	}()
	for i := 0; i < 9; i++ {
		<-done
	}
	var openAttempts, activeTasks int
	_ = r.db.QueryRow(ctx, `select count(*) from attempts where state = 'running'`).Scan(&openAttempts)
	_ = r.db.QueryRow(ctx, `select count(*) from tasks where state in ('queued', 'running')`).Scan(&activeTasks)
	if openAttempts != 0 || activeTasks != 0 {
		t.Fatalf("running attempts=%d active tasks=%d", openAttempts, activeTasks)
	}
}

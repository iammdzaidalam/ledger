package orch_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

func passTasks(r *rig, swarmID string, n int) {
	r.t.Helper()
	for i := 0; i < n; i++ {
		a := r.mustClaim(swarmID, "w")
		r.turn(a, 1, false)
		if resp := r.mustComplete(finish(a, "w")); resp.Decision != decPass {
			r.t.Fatalf("task %d: %+v", i, resp)
		}
	}
}

func TestMergesRunOneAtATime(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{tasks: 2, gate: true})
	w := r.watch(sw.Id)
	passTasks(r, sw.Id, 2)

	first := r.claimMerge(sw.Id, "coord")
	if first.Job == nil || first.Job.Branch == "" || first.Job.Commit != "abc123" || first.Job.Repo != "/repo" || first.SwarmFinished {
		t.Fatalf("first: %+v", first)
	}
	if got := r.claimMerge(sw.Id, "other"); got.Job != nil || got.SwarmFinished {
		t.Fatalf("second claim during a merge: %+v", got)
	}
	if got := r.claimMerge(sw.Id, "coord2"); got.Job != nil {
		t.Fatalf("third claim during a merge: %+v", got)
	}
	if got := r.taskState(sw.Id, 1); got != ledgerv1.TaskState_TASK_STATE_PASSED {
		t.Fatalf("second task is %v", got)
	}

	if _, err := r.finishMerge(first.Job.TaskId, "other", true); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("finish by another worker: %v", err)
	}
	done, err := r.finishMerge(first.Job.TaskId, "coord", true)
	if err != nil || done.State != ledgerv1.TaskState_TASK_STATE_MERGED || len(done.Attempts) != 1 {
		t.Fatalf("finish: %+v %v", done, err)
	}
	again, err := r.finishMerge(first.Job.TaskId, "coord", true)
	if err != nil || again.State != ledgerv1.TaskState_TASK_STATE_MERGED {
		t.Fatalf("finish replay: %+v %v", again, err)
	}
	if _, err := r.finishMerge(first.Job.TaskId, "coord", false); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("finish contradicting the first outcome: %v", err)
	}

	second := r.claimMerge(sw.Id, "other")
	if second.Job == nil || second.Job.TaskId == first.Job.TaskId || second.SwarmFinished {
		t.Fatalf("second: %+v", second)
	}
	if _, err := r.finishMerge(second.Job.TaskId, "other", true); err != nil {
		t.Fatal(err)
	}
	last := r.claimMerge(sw.Id, "other")
	if last.Job != nil || !last.SwarmFinished {
		t.Fatalf("last: %+v", last)
	}
	got := r.get(sw.Id)
	if got.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_DONE || got.Swarm.FinishedAt == nil || got.Swarm.TaskCounts["merged"] != 2 {
		t.Fatalf("swarm: %+v", got.Swarm)
	}
	types := w.types()
	if count(types, "task.merging") != 2 || count(types, "task.merged") != 2 || count(types, "swarm.done") != 1 {
		t.Fatalf("events: %v", types)
	}
}

func TestConflictedMergeIsTerminalAndTheQueueMovesOn(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{tasks: 2})
	w := r.watch(sw.Id)
	passTasks(r, sw.Id, 2)

	first := r.claimMerge(sw.Id, "coord")
	task, err := r.finishMerge(first.Job.TaskId, "coord", false)
	if err != nil || task.State != ledgerv1.TaskState_TASK_STATE_CONFLICT || task.Detail != "from test" {
		t.Fatalf("conflict: %+v %v", task, err)
	}
	second := r.claimMerge(sw.Id, "coord")
	if second.Job == nil || second.Job.TaskId == first.Job.TaskId {
		t.Fatalf("queue stalled: %+v", second)
	}
	if _, err := r.finishMerge(second.Job.TaskId, "coord", true); err != nil {
		t.Fatal(err)
	}
	got := r.get(sw.Id)
	if got.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_DONE || got.Swarm.TaskCounts["conflict"] != 1 || got.Swarm.TaskCounts["merged"] != 1 {
		t.Fatalf("swarm: %+v", got.Swarm)
	}
	if types := w.types(); count(types, "task.conflict") != 1 {
		t.Fatalf("events: %v", types)
	}
}

func TestACrashedCoordinatorsMergeIsOfferedAgain(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{})
	passTasks(r, sw.Id, 1)
	first := r.claimMerge(sw.Id, "coord-1")
	if first.Job == nil {
		t.Fatal("no job")
	}
	if got := r.claimMerge(sw.Id, "coord-2"); got.Job != nil {
		t.Fatalf("lease still held: %+v", got)
	}
	if _, err := r.db.Exec(context.Background(), `update tasks set merge_until = now() - interval '1 second' where id = $1`, first.Job.TaskId); err != nil {
		t.Fatal(err)
	}
	again := r.claimMerge(sw.Id, "coord-2")
	if again.Job == nil || again.Job.TaskId != first.Job.TaskId {
		t.Fatalf("not re-offered: %+v", again)
	}
	if _, err := r.finishMerge(first.Job.TaskId, "coord-1", true); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("the crashed coordinator must no longer finish it: %v", err)
	}
	if _, err := r.finishMerge(first.Job.TaskId, "coord-2", true); err != nil {
		t.Fatal(err)
	}
}

func TestSwarmFinishedWaitsForEveryTask(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{tasks: 2, gate: true})
	a := r.mustClaim(sw.Id, "w")
	r.turn(a, 1, false)
	r.mustComplete(finish(a, "w"))
	if got := r.claimMerge(sw.Id, "c"); got.Job == nil || got.SwarmFinished {
		t.Fatalf("with a task still queued: %+v", got)
	}
	if got := r.claimMerge(sw.Id, "c"); got.Job == nil || got.SwarmFinished {
		t.Fatalf("same worker re-claiming its own merge: %+v", got)
	}
	if got := r.claimMerge(sw.Id, "d"); got.Job != nil || got.SwarmFinished {
		t.Fatalf("with a task queued and one merging: %+v", got)
	}
}

func TestClaimMergeValidation(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	if _, err := r.swarm.ClaimMerge(ctx, connect.NewRequest(&ledgerv1.ClaimMergeRequest{WorkerId: "c"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("no swarm: %v", err)
	}
	if _, err := r.swarm.ClaimMerge(ctx, connect.NewRequest(&ledgerv1.ClaimMergeRequest{SwarmId: "nope", WorkerId: "c"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown swarm: %v", err)
	}
	if _, err := r.finishMerge("nope", "c", true); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown task: %v", err)
	}
	sw := r.create(spec{})
	task := r.get(sw.Id).Tasks[0]
	if _, err := r.finishMerge(task.Id, "c", true); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("finishing a task that is not merging: %v", err)
	}
}

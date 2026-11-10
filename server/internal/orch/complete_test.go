package orch_test

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

const (
	decPass  = ledgerv1.GateDecision_GATE_DECISION_PASS
	decRetry = ledgerv1.GateDecision_GATE_DECISION_RETRY
	decBlock = ledgerv1.GateDecision_GATE_DECISION_BLOCK
	decFail  = ledgerv1.GateDecision_GATE_DECISION_FAIL
)

func TestGatePassesACleanAttempt(t *testing.T) {
	r := newRig(t)
	w := r.watch("")
	sw := r.create(spec{gate: true})
	a := r.mustClaim(sw.Id, "w1")
	r.turn(a, 1, false)
	resp := r.mustComplete(finish(a, "w1"))
	if resp.Decision != decPass || resp.Turns != 1 || resp.FlaggedTurns != 0 {
		t.Fatalf("got %+v", resp)
	}
	if got := r.taskState(sw.Id, 0); got != ledgerv1.TaskState_TASK_STATE_PASSED {
		t.Fatalf("task is %v", got)
	}
	types := w.types()
	for _, want := range []string{"swarm.created", "task.queued", "task.claimed", "attempt.turn", "attempt.completed", "gate.pass"} {
		if count(types, want) != 1 {
			t.Errorf("%s x%d in %v", want, count(types, want), types)
		}
	}
}

func TestGateFailsOnWorkerErrorAndMissingCommit(t *testing.T) {
	cases := map[string]func(*ledgerv1.CompleteAttemptRequest){
		"worker error": func(q *ledgerv1.CompleteAttemptRequest) { q.Error = "agent crashed" },
		"no commit":    func(q *ledgerv1.CompleteAttemptRequest) { q.Commit = "" },
		"no branch":    func(q *ledgerv1.CompleteAttemptRequest) { q.Branch = "" },
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			sw := r.create(spec{gate: true, attempts: 1})
			a := r.mustClaim(sw.Id, "w1")
			req := finish(a, "w1")
			edit(req)
			resp := r.mustComplete(req)
			if resp.Decision != decFail {
				t.Fatalf("got %+v", resp)
			}
			got := r.get(sw.Id)
			if got.Tasks[0].State != ledgerv1.TaskState_TASK_STATE_FAILED || got.Tasks[0].Detail == "" {
				t.Fatalf("task: %+v", got.Tasks[0])
			}
			if got.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_DONE {
				t.Fatalf("swarm is %v", got.Swarm.State)
			}
		})
	}
}

func TestGateRetriesThenPasses(t *testing.T) {
	r := newRig(t)
	w := r.watch("")
	sw := r.create(spec{gate: true, attempts: 2})
	a1 := r.mustClaim(sw.Id, "w1")
	r.turn(a1, 1, true)
	resp := r.mustComplete(finish(a1, "w1"))
	if resp.Decision != decRetry || resp.FlaggedTurns != 1 {
		t.Fatalf("first: %+v", resp)
	}
	if got := r.taskState(sw.Id, 0); got != ledgerv1.TaskState_TASK_STATE_QUEUED {
		t.Fatalf("task is %v", got)
	}

	a2 := r.mustClaim(sw.Id, "w2")
	if a2.AttemptNumber != 2 || a2.RunId == a1.RunId {
		t.Fatalf("second assignment: %+v", a2)
	}
	for _, want := range []string{"All tests pass.", "test", "contradicted"} {
		if !strings.Contains(a2.Feedback, want) {
			t.Errorf("feedback misses %q: %s", want, a2.Feedback)
		}
	}
	r.turn(a2, 1, false)
	if resp := r.mustComplete(finish(a2, "w2")); resp.Decision != decPass {
		t.Fatalf("second: %+v", resp)
	}
	task := r.get(sw.Id).Tasks[0]
	if len(task.Attempts) != 2 || task.Attempts[0].Decision != decRetry || task.Attempts[1].Decision != decPass || task.Attempts[1].Feedback != a2.Feedback {
		t.Fatalf("attempts: %+v", task.Attempts)
	}
	types := w.types()
	if count(types, "gate.retry") != 1 || count(types, "gate.pass") != 1 || count(types, "task.queued") != 2 {
		t.Fatalf("events: %v", types)
	}
}

func TestGateRetriesThenBlocks(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: true, attempts: 2})
	a1 := r.mustClaim(sw.Id, "w1")
	r.turn(a1, 1, true)
	if resp := r.mustComplete(finish(a1, "w1")); resp.Decision != decRetry {
		t.Fatalf("first: %+v", resp)
	}
	a2 := r.mustClaim(sw.Id, "w1")
	r.turn(a2, 1, false)
	r.turn(a2, 2, true)
	resp := r.mustComplete(finish(a2, "w1"))
	if resp.Decision != decBlock || resp.Turns != 2 || resp.FlaggedTurns != 1 {
		t.Fatalf("second: %+v", resp)
	}
	got := r.get(sw.Id)
	if got.Tasks[0].State != ledgerv1.TaskState_TASK_STATE_BLOCKED || got.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_DONE {
		t.Fatalf("state: %v / %v", got.Tasks[0].State, got.Swarm.State)
	}
	if r.claim(sw.Id, "w1") != nil {
		t.Fatal("a blocked task must not be offered again")
	}
}

func TestOnlyTheLastTurnDecidesTheGate(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: true})
	a := r.mustClaim(sw.Id, "w1")
	r.turn(a, 1, true)
	r.turn(a, 2, false)
	resp := r.mustComplete(finish(a, "w1"))
	if resp.Decision != decPass || resp.FlaggedTurns != 1 || resp.Turns != 2 {
		t.Fatalf("got %+v", resp)
	}
}

func TestUngatedModePassesTheFlaggedAttempt(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: false})
	a := r.mustClaim(sw.Id, "w1")
	r.turn(a, 1, true)
	resp := r.mustComplete(finish(a, "w1"))
	if resp.Decision != decPass || resp.FlaggedTurns != 1 {
		t.Fatalf("got %+v", resp)
	}
	if got := r.taskState(sw.Id, 0); got != ledgerv1.TaskState_TASK_STATE_PASSED {
		t.Fatalf("task is %v", got)
	}
}

func TestUngatedModeFailsWithoutExitZeroOrCommit(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{})
	a := r.mustClaim(sw.Id, "w1")
	req := finish(a, "w1")
	req.Commit, req.ExitCode = "", 1
	if resp := r.mustComplete(req); resp.Decision != decFail {
		t.Fatalf("got %+v", resp)
	}
}

func TestCompleteAttemptReplayReturnsTheSameDecision(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: true, attempts: 3})
	w := r.watch(sw.Id)
	a := r.mustClaim(sw.Id, "w1")
	r.turn(a, 1, true)
	first := r.mustComplete(finish(a, "w1"))
	w.types()
	for i := 0; i < 3; i++ {
		again := r.mustComplete(finish(a, "w1"))
		if again.Decision != first.Decision || again.Reason != first.Reason || again.Turns != first.Turns || again.FlaggedTurns != first.FlaggedTurns {
			t.Fatalf("replay %d: %+v vs %+v", i, again, first)
		}
	}
	changed := finish(a, "w1")
	changed.Error = "late failure"
	if again := r.mustComplete(changed); again.Decision != decRetry {
		t.Fatalf("replay with other payload changed the decision: %+v", again)
	}
	if extra := w.types(); len(extra) != 0 {
		t.Fatalf("replays published %v", extra)
	}
	got := r.get(sw.Id).Tasks[0]
	if len(got.Attempts) != 1 || got.State != ledgerv1.TaskState_TASK_STATE_QUEUED {
		t.Fatalf("task after replays: %+v", got)
	}
	var used int
	_ = r.db.QueryRow(context.Background(), `select attempts from tasks where id = $1`, got.Id).Scan(&used)
	if used != 1 {
		t.Fatalf("attempts counter is %d", used)
	}
}

func TestCompleteAttemptRejectsAStaleWorker(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{gate: true, attempts: 3})
	a := r.mustClaim(sw.Id, "w1")

	_, err := r.complete(finish(a, "w2"))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "belongs to worker w1") {
		t.Fatalf("other worker: %v", err)
	}

	r.expire(a.AttemptId)
	b := r.mustClaim(sw.Id, "w2")
	if b.AttemptNumber != 2 || b.TaskId != a.TaskId {
		t.Fatalf("reclaim: %+v", b)
	}
	_, err = r.complete(finish(a, "w1"))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "lost its lease") {
		t.Fatalf("expired attempt: %v", err)
	}
	if _, err := r.swarm.CompleteAttempt(ctx, connect.NewRequest(&ledgerv1.CompleteAttemptRequest{AttemptId: "nope", WorkerId: "w"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown attempt: %v", err)
	}
	if _, err := r.swarm.CompleteAttempt(ctx, connect.NewRequest(&ledgerv1.CompleteAttemptRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty request: %v", err)
	}
}

func TestGateDecisionsAreCounted(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: true, attempts: 2})
	a := r.mustClaim(sw.Id, "w1")
	r.turn(a, 1, true)
	r.mustComplete(finish(a, "w1"))
	b := r.mustClaim(sw.Id, "w1")
	r.turn(b, 1, false)
	r.mustComplete(finish(b, "w1"))

	got := gather(t, r)
	for name, want := range map[string]float64{
		`ledger_gate_decisions_total{decision="retry"}`: 1,
		`ledger_gate_decisions_total{decision="pass"}`:  1,
		`ledger_attempts_total{outcome="retried"}`:      1,
		`ledger_attempts_total{outcome="passed"}`:       1,
		`ledger_tasks_total{state="passed"}`:            1,
		`ledger_tasks_total{state="queued"}`:            0,
	} {
		if got[name] != want {
			t.Errorf("%s = %v, want %v", name, got[name], want)
		}
	}
}

func TestNoChangeRetriesWithAHintThenFails(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: true, attempts: 2})
	a1 := r.mustClaim(sw.Id, "w1")
	req := finish(a1, "w1")
	req.Commit, req.Branch = "", ""
	if resp := r.mustComplete(req); resp.Decision != decRetry {
		t.Fatalf("first empty attempt: %+v", resp)
	}
	a2 := r.mustClaim(sw.Id, "w1")
	if a2.Feedback == "" || a2.AttemptNumber != 2 {
		t.Fatalf("no hint on the retry: %+v", a2)
	}
	req = finish(a2, "w1")
	req.Commit, req.Branch = "", ""
	if resp := r.mustComplete(req); resp.Decision != decFail {
		t.Fatalf("second empty attempt: %+v", resp)
	}
}

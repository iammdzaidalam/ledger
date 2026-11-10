package orch_test

import (
	"context"
	"testing"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

func TestExpiredLeaseIsReclaimedWithTheSameFeedback(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{gate: true, attempts: 3})
	w := r.watch(sw.Id)

	a1 := r.mustClaim(sw.Id, "w1")
	r.turn(a1, 1, true)
	r.mustComplete(finish(a1, "w1"))

	a2 := r.mustClaim(sw.Id, "w1")
	if a2.Feedback == "" {
		t.Fatal("second attempt should carry feedback")
	}
	r.expire(a2.AttemptId)
	a3 := r.mustClaim(sw.Id, "w2")
	if a3.AttemptNumber != 3 || a3.TaskId != a2.TaskId || a3.AttemptId == a2.AttemptId {
		t.Fatalf("reclaim: %+v", a3)
	}
	if a3.Feedback != a2.Feedback {
		t.Fatalf("feedback changed across the reclaim:\n%s\n---\n%s", a2.Feedback, a3.Feedback)
	}

	attempts := r.get(sw.Id).Tasks[0].Attempts
	if len(attempts) != 3 || attempts[1].FinishedAt == nil || attempts[1].Decision != ledgerv1.GateDecision_GATE_DECISION_UNSPECIFIED || attempts[2].FinishedAt != nil {
		t.Fatalf("attempts: %+v", attempts)
	}
	var state string
	_ = r.db.QueryRow(ctx, `select state from attempts where id = $1`, a2.AttemptId).Scan(&state)
	if state != "expired" {
		t.Fatalf("old attempt is %s", state)
	}
	types := w.types()
	if count(types, "task.heartbeat_lost") != 1 || count(types, "task.claimed") != 3 {
		t.Fatalf("events: %v", types)
	}
	if got := gather(t, r)["ledger_lease_expired_total"]; got != 1 {
		t.Fatalf("lease_expired_total = %v", got)
	}
	if got := gather(t, r)[`ledger_attempts_total{outcome="expired"}`]; got != 1 {
		t.Fatalf("expired attempts = %v", got)
	}
}

func TestExpiredAttemptOnTheLastTryFailsTheTask(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{gate: true, attempts: 1})
	a := r.mustClaim(sw.Id, "w1")
	r.expire(a.AttemptId)
	if got := r.claim(sw.Id, "w2"); got != nil {
		t.Fatalf("no attempts are left, got %+v", got)
	}
	got := r.get(sw.Id)
	if got.Tasks[0].State != ledgerv1.TaskState_TASK_STATE_FAILED || got.Tasks[0].Detail == "" || got.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_DONE {
		t.Fatalf("got %v %q / %v", got.Tasks[0].State, got.Tasks[0].Detail, got.Swarm.State)
	}
}

func TestReaperRequeuesAndFails(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	roomy := r.create(spec{attempts: 2})
	tight := r.create(spec{attempts: 1})
	w := r.watch("")
	a := r.mustClaim(roomy.Id, "w1")
	b := r.mustClaim(tight.Id, "w1")
	live := r.create(spec{})
	c := r.mustClaim(live.Id, "w1")
	r.expire(a.AttemptId)
	r.expire(b.AttemptId)

	n, err := r.svc.Reap(ctx)
	if err != nil || n != 2 {
		t.Fatalf("reaped %d (%v)", n, err)
	}
	if got := r.taskState(roomy.Id, 0); got != ledgerv1.TaskState_TASK_STATE_QUEUED {
		t.Fatalf("roomy is %v", got)
	}
	if got := r.taskState(tight.Id, 0); got != ledgerv1.TaskState_TASK_STATE_FAILED {
		t.Fatalf("tight is %v", got)
	}
	if got := r.taskState(live.Id, 0); got != ledgerv1.TaskState_TASK_STATE_RUNNING {
		t.Fatalf("live is %v", got)
	}
	if n, _ := r.svc.Reap(ctx); n != 0 {
		t.Fatalf("second pass reaped %d", n)
	}
	types := w.types()
	if count(types, "task.heartbeat_lost") != 2 || count(types, "swarm.done") != 1 {
		t.Fatalf("events: %v", types)
	}
	if again := r.mustClaim(roomy.Id, "w9"); again.AttemptNumber != 2 {
		t.Fatalf("requeued task: %+v", again)
	}
	_ = c
}

func TestSeveralReapersCloseEachAttemptOnce(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	sw := r.create(spec{tasks: 12, attempts: 3})
	var claimed []*ledgerv1.Assignment
	for i := 0; i < 12; i++ {
		claimed = append(claimed, r.mustClaim(sw.Id, "w1"))
	}
	for _, a := range claimed {
		r.expire(a.AttemptId)
	}
	sum := 0
	for round := 0; round < 20 && sum < 12; round++ {
		total := make(chan int, 6)
		for i := 0; i < 6; i++ {
			go func() {
				n, err := r.svc.Reap(ctx)
				if err != nil {
					t.Error(err)
				}
				total <- n
			}()
		}
		for i := 0; i < 6; i++ {
			sum += <-total
		}
	}
	if sum != 12 {
		t.Fatalf("reapers closed %d attempts, want 12", sum)
	}
	var open, expired int
	_ = r.db.QueryRow(ctx, `select count(*) filter (where state = 'running'), count(*) filter (where state = 'expired') from attempts`).Scan(&open, &expired)
	if open != 0 || expired != 12 {
		t.Fatalf("running=%d expired=%d", open, expired)
	}
	if got := gather(t, r)["ledger_lease_expired_total"]; got != 12 {
		t.Fatalf("lease_expired_total = %v", got)
	}
}

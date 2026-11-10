package orch_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFullLifecycleOverConnect(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()

	stream := r.stream("")

	created, err := r.swarm.CreateSwarm(ctx, connect.NewRequest(&ledgerv1.CreateSwarmRequest{
		IdempotencyKey: "life", Goal: "add search", Repo: "/repo", BaseRef: "main", Model: "qwen", Gate: true, MaxAttempts: 2,
		Subtasks: []*ledgerv1.SubtaskSpec{{Title: "index", Prompt: "build the index"}, {Title: "api", Prompt: "expose the api"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	id := created.Msg.Swarm.Id

	first := r.mustClaim(id, "w1")
	second := r.mustClaim(id, "w2")
	r.turn(first, 1, true)
	r.turn(second, 1, false)
	if resp := r.mustComplete(finish(first, "w1")); resp.Decision != decRetry {
		t.Fatalf("first: %+v", resp)
	}
	if resp := r.mustComplete(finish(second, "w2")); resp.Decision != decPass {
		t.Fatalf("second: %+v", resp)
	}
	retry := r.mustClaim(id, "w3")
	if retry.TaskId != first.TaskId || retry.Feedback == "" {
		t.Fatalf("retry: %+v", retry)
	}
	r.turn(retry, 1, false)
	if resp := r.mustComplete(finish(retry, "w3")); resp.Decision != decPass {
		t.Fatalf("retry: %+v", resp)
	}
	if hb, err := r.swarm.Heartbeat(ctx, connect.NewRequest(&ledgerv1.HeartbeatRequest{AttemptId: retry.AttemptId, WorkerId: "w3"})); err != nil || hb.Msg.LeaseHeld {
		t.Fatalf("heartbeat after completion: %v %v", hb, err)
	}

	for i := 0; i < 2; i++ {
		job := r.claimMerge(id, "coord").Job
		if job == nil {
			t.Fatalf("merge %d: no job", i)
		}
		if _, err := r.finishMerge(job.TaskId, "coord", true); err != nil {
			t.Fatal(err)
		}
	}
	if end := r.claimMerge(id, "coord"); !end.SwarmFinished {
		t.Fatalf("end: %+v", end)
	}

	got := r.get(id)
	if got.Swarm.State != ledgerv1.SwarmState_SWARM_STATE_DONE || got.Swarm.TaskCounts["merged"] != 2 || len(got.Tasks[0].Attempts) != 2 {
		t.Fatalf("swarm: %+v", got)
	}
	list, err := r.swarm.ListSwarms(ctx, connect.NewRequest(&ledgerv1.ListSwarmsRequest{}))
	if err != nil || len(list.Msg.Swarms) != 1 || list.Msg.Swarms[0].Id != id {
		t.Fatalf("list: %+v %v", list, err)
	}

	var types []string
	for !contains(types, "swarm.done") {
		e := nextEvent(t, stream)
		if e.SwarmId != id || e.At == nil {
			t.Fatalf("bad event %+v", e)
		}
		var data map[string]any
		if err := json.Unmarshal([]byte(e.DataJson), &data); err != nil {
			t.Fatalf("data_json %q: %v", e.DataJson, err)
		}
		if e.Type == "attempt.turn" && (data["turn"] == nil || data["flagged"] == nil) {
			t.Fatalf("turn event data: %v", data)
		}
		types = append(types, e.Type)
	}
	want := []string{"swarm.created", "task.queued", "task.queued", "task.claimed", "task.claimed", "attempt.turn", "attempt.turn",
		"attempt.completed", "task.queued", "gate.retry", "attempt.completed", "gate.pass", "task.claimed", "attempt.turn",
		"attempt.completed", "gate.pass", "task.merging", "task.merged", "task.merging", "task.merged", "swarm.done"}
	if strings.Join(types, " ") != strings.Join(want, " ") {
		t.Fatalf("event order:\n got %v\nwant %v", types, want)
	}
}

func (r *rig) stream(swarmID string) <-chan *ledgerv1.SwarmEvent {
	r.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r.t.Cleanup(cancel)
	before := r.hub.Subscribers()
	out := make(chan *ledgerv1.SwarmEvent, 256)
	go func() {
		defer close(out)
		s, err := r.swarm.StreamEvents(ctx, connect.NewRequest(&ledgerv1.StreamEventsRequest{SwarmId: swarmID}))
		if err != nil {
			return
		}
		defer s.Close()
		for s.Receive() {
			out <- s.Msg()
		}
	}()
	waitFor(r.t, "stream subscriber", func() bool { return r.hub.Subscribers() > before })
	return out
}

func nextEvent(t *testing.T, ch <-chan *ledgerv1.SwarmEvent) *ledgerv1.SwarmEvent {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("stream closed")
		}
		return e
	case <-time.After(3 * time.Second):
		t.Fatal("no event within 3s")
		return nil
	}
}

func contains(list []string, s string) bool { return count(list, s) > 0 }

func TestStreamEventsFiltersBySwarm(t *testing.T) {
	r := newRig(t)
	a, b := r.create(spec{}), r.create(spec{})
	stream := r.stream(b.Id)
	r.mustClaim(a.Id, "w")
	r.mustClaim(b.Id, "w")
	if e := nextEvent(t, stream); e.SwarmId != b.Id || e.Type != "task.claimed" {
		t.Fatalf("got %+v", e)
	}
}

func TestServerSentEventsCarryTheEventJSON(t *testing.T) {
	r := newRig(t)
	sw := r.create(spec{})
	req, _ := http.NewRequest("GET", r.server.URL+"/events?swarm="+sw.Id, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	resp, err := r.server.Client().Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	lines := bufio.NewScanner(resp.Body)
	waitFor(t, "subscriber", func() bool { return r.hub.Subscribers() == 1 })
	a := r.mustClaim(sw.Id, "w1")

	var payload string
	for lines.Scan() {
		if text, ok := strings.CutPrefix(lines.Text(), "data: "); ok {
			payload = text
			break
		}
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatalf("payload %q: %v", payload, err)
	}
	for _, key := range []string{"swarm_id", "task_id", "attempt_id", "type", "message", "data", "at"} {
		if _, ok := got[key]; !ok {
			t.Errorf("missing %q in %s", key, payload)
		}
	}
	if got["type"] != "task.claimed" || got["attempt_id"] != a.AttemptId || got["swarm_id"] != sw.Id {
		t.Fatalf("payload: %s", payload)
	}
}

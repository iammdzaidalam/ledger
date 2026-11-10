package events_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iammdzaidalam/ledger/server/internal/events"
)

func ev(swarm string, n int) events.Event {
	return events.Event{SwarmID: swarm, Type: events.AttemptTurn, Data: map[string]any{"n": n}}
}

func TestHubFiltersBySwarm(t *testing.T) {
	h := events.NewHub(8)
	one, releaseOne := h.Subscribe("a")
	defer releaseOne()
	all, releaseAll := h.Subscribe("")
	defer releaseAll()
	h.Publish(context.Background(), ev("b", 1))
	h.Publish(context.Background(), ev("a", 2))
	if got := <-one; got.SwarmID != "a" {
		t.Fatalf("filtered subscriber got %q", got.SwarmID)
	}
	if got := <-all; got.SwarmID != "b" {
		t.Fatalf("unfiltered subscriber got %q first", got.SwarmID)
	}
}

func TestSlowSubscriberDropsOldestAndNeverBlocksPublishers(t *testing.T) {
	h := events.NewHub(4)
	var drops atomic.Int64
	h.OnDrop = func() { drops.Add(1) }
	slow, releaseSlow := h.Subscribe("")
	defer releaseSlow()
	fast, releaseFast := h.Subscribe("")
	defer releaseFast()

	seen := make(chan int, 100)
	go func() {
		for e := range fast {
			seen <- e.Data["n"].(int)
		}
	}()

	done := make(chan struct{})
	go func() {
		for i := 1; i <= 50; i++ {
			h.Publish(context.Background(), ev("s", i))
			time.Sleep(time.Millisecond)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("publish stalled on a subscriber that does not read")
	}

	if drops.Load() == 0 || h.Dropped() != drops.Load() {
		t.Fatalf("drops=%d hub=%d", drops.Load(), h.Dropped())
	}
	var kept []int
	for len(slow) > 0 {
		kept = append(kept, (<-slow).Data["n"].(int))
	}
	if len(kept) != 4 || kept[3] != 50 || kept[0] != 47 {
		t.Fatalf("slow subscriber kept %v, want the newest four", kept)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case n := <-seen:
			if n == 50 {
				return
			}
		case <-deadline:
			t.Fatal("fast subscriber missed the final event")
		}
	}
}

func TestReleaseIsIdempotentAndCloseEndsStreams(t *testing.T) {
	h := events.NewHub(4)
	ch, release := h.Subscribe("")
	release()
	release()
	if _, open := <-ch; open {
		t.Fatal("channel should be closed after release")
	}
	other, _ := h.Subscribe("x")
	h.Close()
	if _, open := <-other; open {
		t.Fatal("Close should end every subscription")
	}
	if h.Subscribers() != 0 {
		t.Fatalf("subscribers=%d", h.Subscribers())
	}
	h.Publish(context.Background(), ev("x", 1))
}

package events_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/iammdzaidalam/ledger/server/internal/events"
)

func redisURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("LEDGER_TEST_REDIS_URL")
	if url == "" {
		t.Skip("LEDGER_TEST_REDIS_URL is not set")
	}
	return url
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func openRedis(t *testing.T) *events.Redis {
	t.Helper()
	r, err := events.NewRedis(context.Background(), redisURL(t), events.NewHub(64), quiet())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func recv(t *testing.T, ch <-chan events.Event) events.Event {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(3 * time.Second):
		t.Fatal("no event within 3s")
		return events.Event{}
	}
}

func TestRedisDeliversToEverySubscriberOnEveryInstance(t *testing.T) {
	a, b := openRedis(t), openRedis(t)
	a1, relA1 := a.Subscribe("swarm-r1")
	defer relA1()
	a2, relA2 := a.Subscribe("")
	defer relA2()
	b1, relB1 := b.Subscribe("swarm-r1")
	defer relB1()
	other, relOther := b.Subscribe("swarm-other")
	defer relOther()

	a.Publish(context.Background(), events.Event{SwarmID: "swarm-r1", TaskID: "t", Type: events.GatePass, Message: "ok", Data: map[string]any{"k": "v"}})
	for name, ch := range map[string]<-chan events.Event{"a1": a1, "a2": a2, "b1": b1} {
		e := recv(t, ch)
		if e.Type != events.GatePass || e.TaskID != "t" || e.Data["k"] != "v" || e.At.IsZero() {
			t.Fatalf("%s got %+v", name, e)
		}
	}
	select {
	case e := <-other:
		t.Fatalf("filtered subscriber got %+v", e)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRedisResubscribesAfterTheConnectionDrops(t *testing.T) {
	r := openRedis(t)
	ch, release := r.Subscribe("swarm-drop")
	defer release()

	opts, err := redis.ParseURL(redisURL(t))
	if err != nil {
		t.Fatal(err)
	}
	admin := redis.NewClient(opts)
	defer admin.Close()
	if err := admin.Do(context.Background(), "CLIENT", "KILL", "TYPE", "pubsub").Err(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		r.Publish(context.Background(), events.Event{SwarmID: "swarm-drop", Type: events.TaskQueued})
		select {
		case e := <-ch:
			if e.Type != events.TaskQueued {
				t.Fatalf("got %+v", e)
			}
			return
		case <-time.After(300 * time.Millisecond):
		}
	}
	t.Fatal("the subscription never came back")
}

func TestSSEOverRedis(t *testing.T) {
	bus := openRedis(t)
	srv := httptest.NewServer(events.SSE{Bus: bus, Keepalive: 50 * time.Millisecond})
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/?swarm=swarm-sse", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	lines := bufio.NewScanner(resp.Body)

	bus.Publish(ctx, events.Event{SwarmID: "swarm-sse", Type: events.SwarmDone, Message: "finished"})
	bus.Publish(ctx, events.Event{SwarmID: "someone-else", Type: events.SwarmDone})

	sawKeepalive := false
	for lines.Scan() {
		line := lines.Text()
		if line == ": keepalive" {
			sawKeepalive = true
		}
		if body, ok := strings.CutPrefix(line, "data: "); ok {
			var got map[string]any
			if err := json.Unmarshal([]byte(body), &got); err != nil {
				t.Fatal(err)
			}
			if got["swarm_id"] != "swarm-sse" || got["type"] != "swarm.done" || got["message"] != "finished" {
				t.Fatalf("payload %s", body)
			}
			if _, ok := got["data"].(map[string]any); !ok {
				t.Fatalf("data should be an object: %s", body)
			}
			break
		}
	}
	for !sawKeepalive && lines.Scan() {
		sawKeepalive = lines.Text() == ": keepalive"
	}
	if !sawKeepalive {
		t.Fatal("no keepalive comment")
	}
}

func TestOpenFallsBackToMemoryWhenRedisIsDown(t *testing.T) {
	bus := events.Open(context.Background(), "redis://127.0.0.1:1", quiet(), nil)
	defer bus.Close()
	if _, ok := bus.(*events.Hub); !ok {
		t.Fatalf("got %T", bus)
	}
	ch, release := bus.Subscribe("")
	defer release()
	bus.Publish(context.Background(), events.Event{Type: events.SwarmCreated})
	if e := recv(t, ch); e.Type != events.SwarmCreated {
		t.Fatalf("got %+v", e)
	}
}

func TestOpenWithoutAURLIsInMemory(t *testing.T) {
	bus := events.Open(context.Background(), "", quiet(), nil)
	defer bus.Close()
	if _, ok := bus.(*events.Hub); !ok {
		t.Fatalf("got %T", bus)
	}
}

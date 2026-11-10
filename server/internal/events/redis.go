package events

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

const Channel = "ledger:events"

type Redis struct {
	hub    *Hub
	client *redis.Client
	log    *slog.Logger
	cancel context.CancelFunc
	done   chan struct{}
}

func NewRedis(ctx context.Context, url string, hub *Hub, log *slog.Logger) (*Redis, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opts)
	pingCtx, cancelPing := context.WithTimeout(ctx, 3*time.Second)
	defer cancelPing()
	if err := client.Ping(pingCtx).Err(); err != nil {
		client.Close()
		return nil, err
	}
	loopCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	r := &Redis{hub: hub, client: client, log: log, cancel: cancel, done: make(chan struct{})}
	ready := make(chan struct{})
	go r.run(loopCtx, ready)
	select {
	case <-ready:
		return r, nil
	case <-pingCtx.Done():
		r.Close()
		return nil, errors.New("redis subscription did not start")
	}
}

func (r *Redis) run(ctx context.Context, ready chan struct{}) {
	defer close(r.done)
	delay := 500 * time.Millisecond
	signaled := false
	for ctx.Err() == nil {
		connected, err := r.listen(ctx, func() {
			if !signaled {
				signaled = true
				close(ready)
			}
		})
		if ctx.Err() != nil {
			return
		}
		if connected {
			delay = 500 * time.Millisecond
		}
		r.log.Warn("redis event stream lost", "err", err, "retry_in", delay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, 15*time.Second)
	}
}

func (r *Redis) listen(ctx context.Context, onReady func()) (bool, error) {
	ps := r.client.Subscribe(ctx, Channel)
	defer ps.Close()
	stop := context.AfterFunc(ctx, func() { ps.Close() })
	defer stop()
	if _, err := ps.Receive(ctx); err != nil {
		return false, err
	}
	onReady()
	for {
		msg, err := ps.ReceiveMessage(ctx)
		if err != nil {
			return true, err
		}
		var e Event
		if err := json.Unmarshal([]byte(msg.Payload), &e); err != nil {
			r.log.Warn("bad event payload", "err", err)
			continue
		}
		r.hub.deliver(e)
	}
}

func (r *Redis) Publish(ctx context.Context, e Event) {
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	pubCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if err := r.client.Publish(pubCtx, Channel, e.JSON()).Err(); err != nil {
		r.log.Warn("redis publish failed, delivering locally", "err", err)
		r.hub.deliver(e)
	}
}

func (r *Redis) Subscribe(swarmID string) (<-chan Event, func()) { return r.hub.Subscribe(swarmID) }

func (r *Redis) Close() {
	r.cancel()
	<-r.done
	r.client.Close()
	r.hub.Close()
}

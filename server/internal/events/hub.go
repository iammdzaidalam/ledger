package events

import (
	"context"
	"sync"
	"sync/atomic"
)

const DefaultBuffer = 256

type subscriber struct {
	swarmID string
	ch      chan Event
}

type Hub struct {
	OnDrop  func()
	size    int
	mu      sync.Mutex
	next    uint64
	subs    map[uint64]*subscriber
	dropped atomic.Int64
}

func NewHub(size int) *Hub {
	if size < 1 {
		size = DefaultBuffer
	}
	return &Hub{size: size, subs: map[uint64]*subscriber{}}
}

func (h *Hub) Publish(_ context.Context, e Event) { h.deliver(e) }

func (h *Hub) deliver(e Event) {
	if e.Data == nil {
		e.Data = map[string]any{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.subs {
		if s.swarmID != "" && s.swarmID != e.SwarmID {
			continue
		}
		select {
		case s.ch <- e:
			continue
		default:
		}
		select {
		case <-s.ch:
			h.dropped.Add(1)
			if h.OnDrop != nil {
				h.OnDrop()
			}
		default:
		}
		select {
		case s.ch <- e:
		default:
		}
	}
}

func (h *Hub) Subscribe(swarmID string) (<-chan Event, func()) {
	s := &subscriber{swarmID: swarmID, ch: make(chan Event, h.size)}
	h.mu.Lock()
	h.next++
	id := h.next
	h.subs[id] = s
	h.mu.Unlock()
	var once sync.Once
	return s.ch, func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			if _, ok := h.subs[id]; ok {
				delete(h.subs, id)
				close(s.ch)
			}
		})
	}
}

func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

func (h *Hub) Dropped() int64 { return h.dropped.Load() }

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, s := range h.subs {
		delete(h.subs, id)
		close(s.ch)
	}
}

package breaker

import (
	"errors"
	"sync"
	"time"
)

var ErrOpen = errors.New("circuit open")

type State int

const (
	Closed State = iota
	Open
	HalfOpen
)

func (s State) String() string {
	return [...]string{"closed", "open", "half_open"}[s]
}

type Breaker struct {
	Threshold int
	Cooldown  time.Duration
	Now       func() time.Time
	OnChange  func(State)

	mu       sync.Mutex
	state    State
	failures int
	openedAt time.Time
	probing  bool
}

func New(threshold int, cooldown time.Duration) *Breaker {
	return &Breaker{Threshold: threshold, Cooldown: cooldown, Now: time.Now}
}

func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state
}

func (b *Breaker) Do(fn func() error) error {
	if err := b.allow(); err != nil {
		return err
	}
	err := fn()
	b.record(err)
	return err
}

func (b *Breaker) allow() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case Open:
		if b.Now().Sub(b.openedAt) < b.Cooldown {
			return ErrOpen
		}
		b.set(HalfOpen)
		b.probing = true
		return nil
	case HalfOpen:
		if b.probing {
			return ErrOpen
		}
		b.probing = true
	}
	return nil
}

func (b *Breaker) record(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.probing = false
	if err == nil {
		b.failures = 0
		b.set(Closed)
		return
	}
	b.failures++
	if b.state == HalfOpen || b.failures >= b.Threshold {
		b.openedAt = b.Now()
		b.set(Open)
	}
}

func (b *Breaker) set(s State) {
	if b.state == s {
		return
	}
	b.state = s
	if b.OnChange != nil {
		b.OnChange(s)
	}
}

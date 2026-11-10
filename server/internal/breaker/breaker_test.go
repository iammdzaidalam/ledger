package breaker

import (
	"errors"
	"testing"
	"time"
)

var boom = errors.New("boom")

func TestOpensAfterThresholdAndProbesOnce(t *testing.T) {
	now := time.Unix(0, 0)
	b := New(3, 10*time.Second)
	b.Now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if err := b.Do(func() error { return boom }); !errors.Is(err, boom) {
			t.Fatalf("call %d: got %v", i, err)
		}
	}
	if b.State() != Open {
		t.Fatalf("expected open, got %s", b.State())
	}
	called := false
	if err := b.Do(func() error { called = true; return nil }); !errors.Is(err, ErrOpen) || called {
		t.Fatalf("open breaker let a call through: %v", err)
	}

	now = now.Add(11 * time.Second)
	release := make(chan struct{})
	done := make(chan error)
	go func() { done <- b.Do(func() error { <-release; return nil }) }()
	for b.State() != HalfOpen {
		time.Sleep(time.Millisecond)
	}
	if err := b.Do(func() error { return nil }); !errors.Is(err, ErrOpen) {
		t.Fatalf("second probe while half open: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if b.State() != Closed {
		t.Fatalf("expected closed after a good probe, got %s", b.State())
	}
}

func TestFailedProbeReopens(t *testing.T) {
	now := time.Unix(0, 0)
	b := New(1, time.Second)
	b.Now = func() time.Time { return now }
	_ = b.Do(func() error { return boom })
	now = now.Add(2 * time.Second)
	_ = b.Do(func() error { return boom })
	if b.State() != Open {
		t.Fatalf("expected open, got %s", b.State())
	}
	if err := b.Do(func() error { return nil }); !errors.Is(err, ErrOpen) {
		t.Fatalf("cooldown restarted from the failed probe, got %v", err)
	}
}

func TestSuccessResetsTheCount(t *testing.T) {
	b := New(2, time.Second)
	_ = b.Do(func() error { return boom })
	_ = b.Do(func() error { return nil })
	_ = b.Do(func() error { return boom })
	if b.State() != Closed {
		t.Fatalf("two failures split by a success opened it")
	}
}

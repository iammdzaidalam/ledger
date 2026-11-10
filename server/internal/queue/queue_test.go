package queue_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iammdzaidalam/ledger/server/internal/queue"
	"github.com/iammdzaidalam/ledger/server/internal/testdb"
)

func TestConcurrentClaimsNeverShareAJob(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	const jobs = 200
	for i := 0; i < jobs; i++ {
		if _, err := queue.Enqueue(ctx, s.Pool, "k", map[string]int{"i": i}, 3); err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	seen := map[int64]int{}
	var wg sync.WaitGroup
	for w := 0; w < 12; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				j, ok, err := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute)
				if err != nil {
					t.Error(err)
					return
				}
				if !ok {
					return
				}
				mu.Lock()
				seen[j.ID]++
				mu.Unlock()
				if err := queue.Complete(ctx, s.Pool, j.ID); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	if len(seen) != jobs {
		t.Fatalf("claimed %d distinct jobs, want %d", len(seen), jobs)
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("job %d claimed %d times", id, n)
		}
	}
}

func TestExpiredLeaseIsReclaimed(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	if _, err := queue.Enqueue(ctx, s.Pool, "k", 1, 3); err != nil {
		t.Fatal(err)
	}
	first, ok, err := queue.Claim(ctx, s.Pool, []string{"k"}, 50*time.Millisecond)
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	if _, ok, _ := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute); ok {
		t.Fatal("a job under a live lease was handed out twice")
	}
	time.Sleep(120 * time.Millisecond)
	second, ok, err := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute)
	if err != nil || !ok || second.ID != first.ID || second.Attempts != 2 {
		t.Fatalf("expected the crashed worker's job back as attempt 2, got %+v %v %v", second, ok, err)
	}
}

func TestFailureBacksOffThenDies(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	if _, err := queue.Enqueue(ctx, s.Pool, "k", 1, 2); err != nil {
		t.Fatal(err)
	}
	j, _, _ := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute)
	dead, err := queue.Fail(ctx, s.Pool, j, errors.New("boom"))
	if err != nil || dead {
		t.Fatalf("first failure should retry: %v %v", dead, err)
	}
	if _, ok, _ := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute); ok {
		t.Fatal("job was claimable before its backoff elapsed")
	}
	if _, err := s.Pool.Exec(ctx, `update jobs set run_after = now()`); err != nil {
		t.Fatal(err)
	}
	j, ok, _ := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute)
	if !ok {
		t.Fatal("job should be due again")
	}
	if dead, _ := queue.Fail(ctx, s.Pool, j, errors.New("boom")); !dead {
		t.Fatal("second failure of two should dead-letter the job")
	}
}

func TestPermanentFailureSkipsRetries(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	_, _ = queue.Enqueue(ctx, s.Pool, "k", 1, 5)
	j, _, _ := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute)
	dead, _ := queue.Fail(ctx, s.Pool, j, errors.Join(queue.ErrPermanent, errors.New("bad payload")))
	if !dead {
		t.Fatal("permanent errors must dead-letter immediately")
	}
}

func TestParkedJobKeepsItsAttempt(t *testing.T) {
	ctx := context.Background()
	s := testdb.Open(t)
	_, _ = queue.Enqueue(ctx, s.Pool, "k", 1, 1)
	j, _, _ := queue.Claim(ctx, s.Pool, []string{"k"}, time.Minute)
	dead, err := queue.Fail(ctx, s.Pool, j, queue.Delay{After: time.Hour, Cause: errors.New("circuit open")})
	if err != nil || dead {
		t.Fatalf("a parked job must not die: %v %v", dead, err)
	}
	var attempts int
	_ = s.Pool.QueryRow(ctx, `select attempts from jobs where id = $1`, j.ID).Scan(&attempts)
	if attempts != 0 {
		t.Fatalf("parking should refund the attempt, got %d", attempts)
	}
}

type counter struct{ done, retry atomic.Int64 }

func (c *counter) JobDone(_ string, outcome string, _ time.Duration) {
	if outcome == "done" {
		c.done.Add(1)
	} else {
		c.retry.Add(1)
	}
}

func TestPoolRunsEveryJobOnceAndRetriesFailures(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := testdb.Open(t)
	const jobs = 40
	for i := 0; i < jobs; i++ {
		_, _ = queue.Enqueue(ctx, s.Pool, "k", i, 3)
	}
	var runs sync.Map
	var flaky atomic.Bool
	obs := &counter{}
	pool := &queue.Pool{
		DB: s.Pool, Workers: 6, Lease: 5 * time.Second, Idle: 10 * time.Millisecond, Observer: obs,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Handlers: map[string]queue.Handler{"k": func(_ context.Context, j queue.Job) error {
			if j.ID%10 == 0 && flaky.CompareAndSwap(false, true) {
				return errors.New("transient")
			}
			if _, loaded := runs.LoadOrStore(j.ID, true); loaded {
				t.Errorf("job %d ran to completion twice", j.ID)
			}
			return nil
		}},
	}
	finished := make(chan struct{})
	go func() { pool.Run(ctx); close(finished) }()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var open int
		_ = s.Pool.QueryRow(context.Background(), `select count(*) from jobs where state <> 'done'`).Scan(&open)
		if open == 0 {
			break
		}
		if _, err := s.Pool.Exec(context.Background(), `update jobs set run_after = now() where state = 'queued'`); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	<-finished
	count := 0
	runs.Range(func(_, _ any) bool { count++; return true })
	if count != jobs {
		t.Fatalf("%d of %d jobs completed", count, jobs)
	}
	if obs.retry.Load() == 0 {
		t.Fatal("the transient failure was never observed")
	}
}

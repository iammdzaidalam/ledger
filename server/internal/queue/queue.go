package queue

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/iammdzaidalam/ledger/server/internal/store"
)

type Job struct {
	ID          int64
	Kind        string
	Payload     json.RawMessage
	Attempts    int
	MaxAttempts int
}

var ErrPermanent = errors.New("permanent failure")

type Delay struct {
	After time.Duration
	Cause error
}

func (d Delay) Error() string { return "retry later: " + d.Cause.Error() }

func (d Delay) Unwrap() error { return d.Cause }

func Enqueue(ctx context.Context, db store.DB, kind string, payload any, maxAttempts int) (int64, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	var id int64
	err = db.QueryRow(ctx, `insert into jobs (kind, payload, max_attempts) values ($1, $2, $3) returning id`, kind, body, maxAttempts).Scan(&id)
	return id, err
}

func Claim(ctx context.Context, db store.DB, kinds []string, lease time.Duration) (Job, bool, error) {
	var j Job
	err := db.QueryRow(ctx, `
		update jobs set state = 'running', attempts = attempts + 1,
			leased_until = now() + $2::interval, updated_at = now()
		where id = (
			select id from jobs
			where kind = any($1) and (
				(state = 'queued' and run_after <= now()) or
				(state = 'running' and leased_until < now())
			)
			order by run_after, id
			for update skip locked
			limit 1
		)
		returning id, kind, payload, attempts, max_attempts`,
		kinds, lease.String()).Scan(&j.ID, &j.Kind, &j.Payload, &j.Attempts, &j.MaxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, nil
	}
	return j, err == nil, err
}

func Extend(ctx context.Context, db store.DB, id int64, lease time.Duration) error {
	_, err := db.Exec(ctx, `update jobs set leased_until = now() + $2::interval where id = $1 and state = 'running'`, id, lease.String())
	return err
}

func Complete(ctx context.Context, db store.DB, id int64) error {
	_, err := db.Exec(ctx, `update jobs set state = 'done', leased_until = null, updated_at = now() where id = $1`, id)
	return err
}

func Backoff(attempt int) time.Duration {
	base := time.Duration(math.Min(float64(time.Second)*math.Pow(2, float64(attempt-1)), float64(5*time.Minute)))
	return base/2 + time.Duration(rand.Int64N(int64(base/2)+1))
}

func Fail(ctx context.Context, db store.DB, j Job, cause error) (bool, error) {
	var delay Delay
	if errors.As(cause, &delay) {
		_, err := db.Exec(ctx, `
			update jobs set state = 'queued', attempts = attempts - 1, last_error = $2,
				leased_until = null, run_after = now() + $3::interval, updated_at = now()
			where id = $1`, j.ID, cause.Error(), delay.After.String())
		return false, err
	}
	dead := j.Attempts >= j.MaxAttempts || errors.Is(cause, ErrPermanent)
	state := "queued"
	if dead {
		state = "dead"
	}
	_, err := db.Exec(ctx, `
		update jobs set state = $2, last_error = $3, leased_until = null,
			run_after = now() + $4::interval, updated_at = now()
		where id = $1`, j.ID, state, cause.Error(), Backoff(j.Attempts).String())
	return dead, err
}

type Counts map[string]map[string]int

func Depth(ctx context.Context, db store.DB) (Counts, error) {
	rows, err := db.Query(ctx, `select kind, state, count(*) from jobs group by kind, state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := Counts{}
	for rows.Next() {
		var kind, state string
		var n int
		if err := rows.Scan(&kind, &state, &n); err != nil {
			return nil, err
		}
		if out[kind] == nil {
			out[kind] = map[string]int{}
		}
		out[kind][state] = n
	}
	return out, rows.Err()
}

type Handler func(ctx context.Context, j Job) error

type Observer interface {
	JobDone(kind string, outcome string, elapsed time.Duration)
}

type Pool struct {
	DB       *pgxpool.Pool
	Handlers map[string]Handler
	Workers  int
	Lease    time.Duration
	Idle     time.Duration
	Observer Observer
	Log      *slog.Logger
}

func (p *Pool) kinds() []string {
	out := make([]string, 0, len(p.Handlers))
	for k := range p.Handlers {
		out = append(out, k)
	}
	return out
}

func (p *Pool) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < p.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.loop(ctx)
		}()
	}
	wg.Wait()
}

func (p *Pool) loop(ctx context.Context) {
	kinds := p.kinds()
	for ctx.Err() == nil {
		j, ok, err := Claim(ctx, p.DB, kinds, p.Lease)
		if err != nil && ctx.Err() == nil {
			p.Log.Error("claim", "err", err)
		}
		if !ok {
			select {
			case <-ctx.Done():
			case <-time.After(p.Idle):
			}
			continue
		}
		p.handle(ctx, j)
	}
}

func (p *Pool) handle(ctx context.Context, j Job) {
	started := time.Now()
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go p.heartbeat(jobCtx, j.ID)

	err := p.Handlers[j.Kind](jobCtx, j)
	cleanup := context.WithoutCancel(ctx)
	outcome := "done"
	switch {
	case err == nil:
		if cerr := Complete(cleanup, p.DB, j.ID); cerr != nil {
			p.Log.Error("complete", "job", j.ID, "err", cerr)
		}
	default:
		dead, ferr := Fail(cleanup, p.DB, j, err)
		if ferr != nil {
			p.Log.Error("fail", "job", j.ID, "err", ferr)
		}
		outcome = "retry"
		var delay Delay
		if errors.As(err, &delay) {
			outcome = "parked"
		}
		if dead {
			outcome = "dead"
		}
		p.Log.Warn("job failed", "job", j.ID, "kind", j.Kind, "attempt", j.Attempts, "outcome", outcome, "err", err)
	}
	if p.Observer != nil {
		p.Observer.JobDone(j.Kind, outcome, time.Since(started))
	}
}

func (p *Pool) heartbeat(ctx context.Context, id int64) {
	t := time.NewTicker(p.Lease / 3)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := Extend(ctx, p.DB, id, p.Lease); err != nil && ctx.Err() == nil {
				p.Log.Warn("extend lease", "job", id, "err", err)
			}
		}
	}
}

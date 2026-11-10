package store

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

var ErrTurnConflict = errors.New("turn already recorded with different text")

type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Store struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, url string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Close() { s.Pool.Close() }

func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `select pg_advisory_lock(7421)`); err != nil {
		return err
	}
	defer conn.Exec(context.WithoutCancel(ctx), `select pg_advisory_unlock(7421)`)

	if _, err := conn.Exec(ctx, `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		var done bool
		if err := conn.QueryRow(ctx, `select exists(select 1 from schema_migrations where name = $1)`, name).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, err := migrations.ReadFile(name)
		if err != nil {
			return err
		}
		err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `insert into schema_migrations (name) values ($1)`, name)
			return err
		})
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

type RunInfo struct {
	Source string
	Model  string
	Task   string
}

type Turn struct {
	RunID     string
	Turn      int
	Text      string
	Evidence  json.RawMessage
	FreshRefs []string
}

func EnsureRun(ctx context.Context, db DB, id string, info RunInfo) error {
	_, err := db.Exec(ctx, `
		insert into runs (id, source, model, task) values ($1, $2, $3, $4)
		on conflict (id) do update set
			source = case when runs.source = '' then excluded.source else runs.source end,
			model  = case when runs.model  = '' then excluded.model  else runs.model  end,
			task   = case when runs.task   = '' then excluded.task   else runs.task   end`,
		id, info.Source, info.Model, info.Task)
	return err
}

func InsertTurn(ctx context.Context, db DB, t Turn) (bool, error) {
	hash := sha256.Sum256([]byte(t.Text))
	if t.FreshRefs == nil {
		t.FreshRefs = []string{}
	}
	tag, err := db.Exec(ctx, `
		insert into turns (run_id, turn, text, text_hash, evidence, fresh_refs)
		values ($1, $2, $3, $4, $5, $6)
		on conflict (run_id, turn) do nothing`,
		t.RunID, t.Turn, t.Text, hash[:], t.Evidence, t.FreshRefs)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	var existing []byte
	if err := db.QueryRow(ctx, `select text_hash from turns where run_id = $1 and turn = $2`, t.RunID, t.Turn).Scan(&existing); err != nil {
		return false, err
	}
	if string(existing) != string(hash[:]) {
		return false, ErrTurnConflict
	}
	return false, nil
}

type Verdict struct {
	RunID     string
	Turn      int
	Source    string
	Flagged   bool
	Claims    json.RawMessage
	LatencyUs int64
	CreatedAt time.Time
}

func PutVerdict(ctx context.Context, db DB, v Verdict) error {
	_, err := db.Exec(ctx, `
		insert into verdicts (run_id, turn, source, flagged, claims, latency_us)
		values ($1, $2, $3, $4, $5, $6)
		on conflict (run_id, turn, source) do update set
			flagged = excluded.flagged, claims = excluded.claims,
			latency_us = excluded.latency_us, created_at = now()`,
		v.RunID, v.Turn, v.Source, v.Flagged, v.Claims, v.LatencyUs)
	return err
}

func GetVerdict(ctx context.Context, db DB, runID string, turn int, source string) (Verdict, error) {
	v := Verdict{RunID: runID, Turn: turn, Source: source}
	err := db.QueryRow(ctx, `
		select flagged, claims, latency_us, created_at from verdicts
		where run_id = $1 and turn = $2 and source = $3`, runID, turn, source).
		Scan(&v.Flagged, &v.Claims, &v.LatencyUs, &v.CreatedAt)
	return v, err
}

func GetTurn(ctx context.Context, db DB, runID string, turn int) (Turn, error) {
	t := Turn{RunID: runID, Turn: turn}
	err := db.QueryRow(ctx, `select text, evidence, fresh_refs from turns where run_id = $1 and turn = $2`, runID, turn).
		Scan(&t.Text, &t.Evidence, &t.FreshRefs)
	return t, err
}

type RunSummary struct {
	ID        string
	Info      RunInfo
	Turns     int
	Flagged   int
	CreatedAt time.Time
}

type TurnDetail struct {
	Turn          int
	Text          string
	EvidenceCount int
	Verdicts      []Verdict
}

const summaryColumns = `
	r.id, r.source, r.model, r.task, r.created_at,
	(select count(*) from turns t where t.run_id = r.id),
	(select count(distinct v.turn) from verdicts v where v.run_id = r.id and v.source = 'checker' and v.flagged)`

func scanSummary(row pgx.Row) (RunSummary, error) {
	var r RunSummary
	err := row.Scan(&r.ID, &r.Info.Source, &r.Info.Model, &r.Info.Task, &r.CreatedAt, &r.Turns, &r.Flagged)
	return r, err
}

func GetRun(ctx context.Context, db DB, id string) (RunSummary, []TurnDetail, error) {
	run, err := scanSummary(db.QueryRow(ctx, `select `+summaryColumns+` from runs r where r.id = $1`, id))
	if err != nil {
		return run, nil, err
	}
	rows, err := db.Query(ctx, `
		select t.turn, t.text, jsonb_array_length(t.evidence),
		       v.source, v.flagged, v.claims, v.latency_us, v.created_at
		from turns t left join verdicts v on v.run_id = t.run_id and v.turn = t.turn
		where t.run_id = $1
		order by t.turn, v.source`, id)
	if err != nil {
		return run, nil, err
	}
	defer rows.Close()
	var turns []TurnDetail
	for rows.Next() {
		var d TurnDetail
		var source *string
		var flagged *bool
		var claims []byte
		var latency *int64
		var created *time.Time
		if err := rows.Scan(&d.Turn, &d.Text, &d.EvidenceCount, &source, &flagged, &claims, &latency, &created); err != nil {
			return run, nil, err
		}
		if n := len(turns); n == 0 || turns[n-1].Turn != d.Turn {
			turns = append(turns, d)
		}
		if source != nil {
			last := &turns[len(turns)-1]
			last.Verdicts = append(last.Verdicts, Verdict{
				RunID: id, Turn: d.Turn, Source: *source, Flagged: *flagged,
				Claims: claims, LatencyUs: *latency, CreatedAt: *created,
			})
		}
	}
	return run, turns, rows.Err()
}

func ListRuns(ctx context.Context, db DB, limit int, before time.Time) ([]RunSummary, error) {
	rows, err := db.Query(ctx, `select `+summaryColumns+` from runs r where r.created_at < $1 order by r.created_at desc, r.id desc limit $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunSummary
	for rows.Next() {
		r, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

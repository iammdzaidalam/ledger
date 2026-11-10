package orch

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/metrics"
)

const (
	defaultLease    = 120
	maxLease        = 3600
	defaultAttempts = 2
	maxAttempts     = 5
	maxSubtasks     = 100
)

var tracer = otel.Tracer("ledger/orch")

type Service struct {
	DB      *pgxpool.Pool
	Bus     events.Bus
	Metrics *metrics.Metrics
	Log     *slog.Logger
}

type outbox struct {
	events []events.Event
	hooks  []func()
}

func (o *outbox) emit(e events.Event) { o.events = append(o.events, e) }

func (o *outbox) after(f func()) { o.hooks = append(o.hooks, f) }

func (s *Service) tx(ctx context.Context, name string, fn func(ctx context.Context, tx pgx.Tx, out *outbox) error) error {
	ctx, span := tracer.Start(ctx, "tx "+name)
	defer span.End()
	var out outbox
	err := pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		out = outbox{}
		return fn(ctx, tx, &out)
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}
	for _, f := range out.hooks {
		f()
	}
	if s.Bus != nil {
		for _, e := range out.events {
			e.At = time.Now().UTC()
			s.Bus.Publish(ctx, e)
		}
	}
	return nil
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func transition(ctx context.Context, tx pgx.Tx, taskID, from, to, detail string) error {
	_, span := tracer.Start(ctx, "task "+from+" to "+to,
		trace.WithAttributes(attribute.String("task.id", taskID), attribute.String("task.from", from), attribute.String("task.to", to)))
	defer span.End()
	tag, err := tx.Exec(ctx, `
		update tasks set state = $3, detail = $4, updated_at = now()
		where id = $1 and state = $2`, taskID, from, to, detail)
	if err != nil {
		span.RecordError(err)
		return err
	}
	if tag.RowsAffected() != 1 {
		err := fmt.Errorf("task %s is not %s", taskID, from)
		span.RecordError(err)
		return err
	}
	return nil
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func clampLease(seconds int32) int {
	switch {
	case seconds <= 0:
		return defaultLease
	case seconds > maxLease:
		return maxLease
	}
	return int(seconds)
}

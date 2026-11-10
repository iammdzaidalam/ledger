package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/iammdzaidalam/ledger/server/gen/ledger/v1/ledgerv1connect"
	"github.com/iammdzaidalam/ledger/server/internal/breaker"
	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/judge"
	"github.com/iammdzaidalam/ledger/server/internal/metrics"
	"github.com/iammdzaidalam/ledger/server/internal/orch"
	"github.com/iammdzaidalam/ledger/server/internal/queue"
	"github.com/iammdzaidalam/ledger/server/internal/store"
	"github.com/iammdzaidalam/ledger/server/internal/telemetry"
	"github.com/iammdzaidalam/ledger/server/internal/verify"
	"github.com/iammdzaidalam/ledger/server/internal/web"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return n
	}
	return fallback
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("ledgerd stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	flush, err := telemetry.Setup(ctx, "ledgerd")
	if err != nil {
		return err
	}
	defer func() {
		closing, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := flush(closing); err != nil {
			log.Warn("flush traces", "err", err)
		}
	}()

	db, err := store.Open(ctx, env("LEDGER_DATABASE_URL", "postgres://ledger:ledger@localhost:5432/ledger"))
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		return err
	}

	m := metrics.New(db.Pool)
	bus := events.Open(ctx, os.Getenv("LEDGER_REDIS_URL"), log, m.EventsDropped.Inc)
	defer bus.Close()
	svc := &verify.Service{DB: db.Pool, Metrics: m, Events: bus, JudgeAttempts: envInt("LEDGER_JUDGE_ATTEMPTS", 5)}
	swarm := &orch.Service{DB: db.Pool, Bus: bus, Metrics: m, Log: log}

	reaper := make(chan struct{})
	go func() {
		defer close(reaper)
		swarm.RunReaper(ctx, 10*time.Second)
	}()

	workers := make(chan struct{})
	if model := os.Getenv("LEDGER_JUDGE_MODEL"); model != "" {
		svc.JudgeEnabled = true
		b := breaker.New(envInt("LEDGER_JUDGE_BREAKER_FAILURES", 5), time.Duration(envInt("LEDGER_JUDGE_BREAKER_COOLDOWN_S", 30))*time.Second)
		b.OnChange = func(s breaker.State) {
			m.Breaker.Set(float64(s))
			log.Warn("judge breaker", "state", s.String())
		}
		client := &judge.Client{
			BaseURL: env("LEDGER_JUDGE_URL", "http://localhost:11434/v1"),
			Model:   model,
			APIKey:  os.Getenv("LEDGER_JUDGE_API_KEY"),
			HTTP:    &http.Client{Timeout: time.Duration(envInt("LEDGER_JUDGE_TIMEOUT_S", 60)) * time.Second},
			Breaker: b,
		}
		pool := &queue.Pool{
			DB:       db.Pool,
			Handlers: map[string]queue.Handler{verify.JudgeKind: verify.JudgeHandler(db.Pool, client)},
			Workers:  envInt("LEDGER_JUDGE_WORKERS", 2),
			Lease:    2 * time.Minute,
			Idle:     500 * time.Millisecond,
			Observer: m,
			Log:      log,
		}
		go func() {
			defer close(workers)
			pool.Run(ctx)
		}()
		log.Info("judge workers started", "model", model, "workers", pool.Workers)
	} else {
		close(workers)
	}

	traces, err := telemetry.Interceptor()
	if err != nil {
		return err
	}
	opts := []connect.HandlerOption{
		connect.WithInterceptors(traces, m.Interceptor()),
		connect.WithReadMaxBytes(envInt("LEDGER_MAX_REQUEST_BYTES", 8<<20)),
	}
	mux := http.NewServeMux()
	path, handler := ledgerv1connect.NewVerifyServiceHandler(svc, opts...)
	mux.Handle(path, handler)
	path, handler = ledgerv1connect.NewSwarmServiceHandler(swarm, opts...)
	mux.Handle(path, handler)
	mux.Handle("GET /events", events.SSE{Bus: bus})
	mux.Handle("GET /{$}", web.Handler())
	mux.Handle("GET /metrics", promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Pool.Ping(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	srv := &http.Server{
		Addr:              env("LEDGER_ADDR", ":8080"),
		Handler:           mux,
		Protocols:         protocols,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", srv.Addr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err = srv.Shutdown(shutdown)
	<-workers
	<-reaper
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

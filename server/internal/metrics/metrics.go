package metrics

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/iammdzaidalam/ledger/server/internal/queue"
	"github.com/iammdzaidalam/ledger/server/internal/store"
)

type Metrics struct {
	Registry  *prometheus.Registry
	RPC       *prometheus.HistogramVec
	Check     prometheus.Histogram
	Claims    *prometheus.CounterVec
	Turns     *prometheus.CounterVec
	Jobs      *prometheus.CounterVec
	JobTime   *prometheus.HistogramVec
	Breaker   prometheus.Gauge
	queueDesc *prometheus.Desc
	db        store.DB
}

func New(db store.DB) *Metrics {
	m := &Metrics{
		Registry: prometheus.NewRegistry(),
		RPC: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "ledger_rpc_duration_seconds",
			Help:    "RPC latency by procedure and status code.",
			Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
		}, []string{"procedure", "code"}),
		Check: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "ledger_check_duration_seconds",
			Help:    "Time the deterministic checker spends on one turn.",
			Buckets: []float64{.00001, .000025, .00005, .0001, .00025, .0005, .001, .0025, .005, .01},
		}),
		Claims: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ledger_claims_total",
			Help: "Claims found by the checker, by kind and verdict.",
		}, []string{"kind", "verdict"}),
		Turns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ledger_turns_recorded_total",
			Help: "RecordTurn calls by outcome: new, duplicate or conflict.",
		}, []string{"outcome"}),
		Jobs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ledger_jobs_total",
			Help: "Finished job attempts by kind and outcome.",
		}, []string{"kind", "outcome"}),
		JobTime: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "ledger_job_duration_seconds",
			Help:    "Job attempt duration by kind.",
			Buckets: prometheus.ExponentialBuckets(0.01, 2.5, 10),
		}, []string{"kind"}),
		Breaker: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ledger_judge_breaker_state",
			Help: "Judge circuit breaker: 0 closed, 1 open, 2 half open.",
		}),
		queueDesc: prometheus.NewDesc("ledger_queue_jobs", "Jobs by kind and state.", []string{"kind", "state"}, nil),
		db:        db,
	}
	m.Registry.MustRegister(m.RPC, m.Check, m.Claims, m.Turns, m.Jobs, m.JobTime, m.Breaker, m,
		prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	return m
}

func (m *Metrics) Describe(ch chan<- *prometheus.Desc) { ch <- m.queueDesc }

func (m *Metrics) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	counts, err := queue.Depth(ctx, m.db)
	if err != nil {
		return
	}
	for kind, states := range counts {
		for state, n := range states {
			ch <- prometheus.MustNewConstMetric(m.queueDesc, prometheus.GaugeValue, float64(n), kind, state)
		}
	}
}

func (m *Metrics) JobDone(kind, outcome string, elapsed time.Duration) {
	m.Jobs.WithLabelValues(kind, outcome).Inc()
	m.JobTime.WithLabelValues(kind).Observe(elapsed.Seconds())
}

func (m *Metrics) Interceptor() connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			started := time.Now()
			resp, err := next(ctx, req)
			code := "ok"
			if err != nil {
				code = connect.CodeUnknown.String()
				var ce *connect.Error
				if errors.As(err, &ce) {
					code = ce.Code().String()
				}
			}
			m.RPC.WithLabelValues(req.Spec().Procedure, code).Observe(time.Since(started).Seconds())
			return resp, err
		}
	}
}

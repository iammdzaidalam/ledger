package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/gen/ledger/v1/ledgerv1connect"
)

func main() {
	url := flag.String("url", "http://localhost:8080", "ledgerd base URL")
	method := flag.String("method", "record", "record (persist) or check (stateless)")
	conc := flag.Int("c", 32, "concurrent clients")
	dur := flag.Duration("d", 15*time.Second, "test duration")
	evidenceCalls := flag.Int("evidence", 12, "evidence entries per turn")
	dupes := flag.Float64("dupes", 0.1, "fraction of record calls that replay an earlier turn")
	flag.Parse()

	client := ledgerv1connect.NewVerifyServiceClient(&http.Client{
		Transport: &http.Transport{MaxIdleConnsPerHost: *conc * 2},
	}, *url)

	evidence := make([]*ledgerv1.Evidence, 0, *evidenceCalls)
	for i := 1; i <= *evidenceCalls; i++ {
		args, _ := structpb.NewStruct(map[string]any{"command": fmt.Sprintf("python -m pytest tests/test_%d.py", i)})
		exit := int32(i % 2)
		evidence = append(evidence, &ledgerv1.Evidence{
			Ref: fmt.Sprintf("c%d", i), Seq: int32(i), Tool: "Bash", Args: args, ExitCode: &exit,
			Executed: true, IsError: exit != 0, RawStdout: "== 3 passed in 0.12s ==",
		})
	}
	text := "I fixed the bug and all tests pass. The script ran successfully."

	ctx, cancel := context.WithTimeout(context.Background(), *dur)
	defer cancel()
	var mu sync.Mutex
	var latencies []time.Duration
	var ok, failed, dup atomic.Int64
	var seq atomic.Int64
	run := fmt.Sprintf("load-%d", time.Now().UnixNano())

	started := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < *conc; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			local := make([]time.Duration, 0, 4096)
			for i := 0; ctx.Err() == nil; i++ {
				t0 := time.Now()
				var err error
				if *method == "check" {
					_, err = client.Check(ctx, connect.NewRequest(&ledgerv1.CheckRequest{TurnText: text, Evidence: evidence, FreshRefs: []string{"c1"}}))
				} else {
					n := seq.Add(1)
					turn := int32(1)
					id := fmt.Sprintf("%s-%d", run, n)
					if i%int(1/maxf(*dupes, 0.001)) == 0 && i > 0 {
						id = fmt.Sprintf("%s-%d", run, n-1)
						dup.Add(1)
					}
					_, err = client.RecordTurn(ctx, connect.NewRequest(&ledgerv1.RecordTurnRequest{
						RunId: id, Turn: turn, TurnText: text, Evidence: evidence, FreshRefs: []string{"c1"},
					}))
				}
				if ctx.Err() != nil || connect.CodeOf(err) == connect.CodeDeadlineExceeded {
					break
				}
				if err != nil {
					if failed.Add(1) <= 3 {
						fmt.Fprintln(os.Stderr, "error:", err)
					}
					continue
				}
				ok.Add(1)
				local = append(local, time.Since(t0))
			}
			mu.Lock()
			latencies = append(latencies, local...)
			mu.Unlock()
		}(w)
	}
	wg.Wait()
	elapsed := time.Since(started)

	if len(latencies) == 0 {
		fmt.Fprintln(os.Stderr, "no successful requests")
		os.Exit(1)
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	q := func(p float64) time.Duration { return latencies[min(len(latencies)-1, int(p*float64(len(latencies))))] }
	fmt.Printf("method=%s clients=%d evidence=%d duration=%s\n", *method, *conc, *evidenceCalls, elapsed.Round(time.Millisecond))
	fmt.Printf("requests=%d errors=%d rps=%.0f\n", ok.Load(), failed.Load(), float64(ok.Load())/elapsed.Seconds())
	fmt.Printf("p50=%s p90=%s p99=%s max=%s\n", q(.5), q(.9), q(.99), latencies[len(latencies)-1])
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

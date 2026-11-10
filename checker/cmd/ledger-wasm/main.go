//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
	"time"

	"github.com/iammdzaidalam/ledger/checker"
)

type response struct {
	checker.CheckResponse
	LatencyUs    int64 `json:"latency_us"`
	Flagged      bool  `json:"flagged"`
	ChangedFiles bool  `json:"changed_files"`
}

func flagged(claims []checker.ClaimResult) bool {
	for _, c := range claims {
		if c.Verdict == checker.Contradicted || c.Verdict == checker.Unsupported {
			return true
		}
	}
	return false
}

func changed(evidence []checker.Evidence) bool {
	for _, e := range evidence {
		if checker.ChangedFiles(e) {
			return true
		}
	}
	return false
}

func check(input string) string {
	var req checker.CheckRequest
	var out response
	if err := json.Unmarshal([]byte(input), &req); err != nil {
		out.CheckResponse = checker.CheckResponse{Claims: []checker.ClaimResult{}, Error: err.Error()}
	} else {
		started := time.Now()
		out.CheckResponse = checker.Evaluate(req)
		out.LatencyUs = time.Since(started).Microseconds()
		out.Flagged = flagged(out.Claims)
		out.ChangedFiles = changed(req.Evidence)
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return `{"claims":[],"error":"could not encode the response"}`
	}
	return string(encoded)
}

func main() {
	js.Global().Set("ledgerCheck", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 {
			return `{"claims":[],"error":"no input"}`
		}
		return check(args[0].String())
	}))
	select {}
}

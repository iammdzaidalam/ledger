package orch_test

import (
	"strings"
	"testing"

	"github.com/iammdzaidalam/ledger/checker"
	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/orch"
)

func TestDecide(t *testing.T) {
	const (
		pass  = ledgerv1.GateDecision_GATE_DECISION_PASS
		retry = ledgerv1.GateDecision_GATE_DECISION_RETRY
		block = ledgerv1.GateDecision_GATE_DECISION_BLOCK
		fail  = ledgerv1.GateDecision_GATE_DECISION_FAIL
	)
	gated := orch.GateInput{Gate: true, Branch: "b", Commit: "c", Attempt: 1, MaxAttempts: 2}
	with := func(f func(*orch.GateInput)) orch.GateInput {
		in := gated
		f(&in)
		return in
	}
	cases := []struct {
		name string
		in   orch.GateInput
		want ledgerv1.GateDecision
	}{
		{"clean and committed", gated, pass},
		{"flagged with attempts left", with(func(i *orch.GateInput) { i.LastFlagged = true }), retry},
		{"flagged on the last attempt", with(func(i *orch.GateInput) { i.LastFlagged, i.Attempt = true, 2 }), block},
		{"flagged past the limit", with(func(i *orch.GateInput) { i.LastFlagged, i.Attempt = true, 3 }), block},
		{"worker error", with(func(i *orch.GateInput) { i.Error = "boom" }), fail},
		{"worker error beats a flag", with(func(i *orch.GateInput) { i.Error, i.LastFlagged = "boom", true }), fail},
		{"no commit with attempts left retries", with(func(i *orch.GateInput) { i.Commit = "" }), retry},
		{"no commit on the last attempt", with(func(i *orch.GateInput) { i.Commit, i.Attempt = "", 2 }), fail},
		{"no branch with attempts left retries", with(func(i *orch.GateInput) { i.Branch = "" }), retry},
		{"no commit and flagged on the last attempt", with(func(i *orch.GateInput) { i.Commit, i.LastFlagged, i.Attempt = "", true, 2 }), fail},
		{"clean but non-zero exit", with(func(i *orch.GateInput) { i.ExitCode = 2 }), fail},
		{"flagged and non-zero exit retries", with(func(i *orch.GateInput) { i.ExitCode, i.LastFlagged = 2, true }), retry},
		{"ungated flagged with a commit", orch.GateInput{Attempt: 1, MaxAttempts: 2, LastFlagged: true, Commit: "c"}, pass},
		{"ungated commit but exit 1", orch.GateInput{ExitCode: 1, Commit: "c"}, pass},
		{"ungated exit 0 without commit has nothing to merge", orch.GateInput{}, fail},
		{"ungated exit 1 without commit", orch.GateInput{ExitCode: 1}, fail},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := orch.Decide(c.in)
			if got.Decision != c.want || got.Reason == "" {
				t.Fatalf("got %v %q, want %v", got.Decision, got.Reason, c.want)
			}
		})
	}
}

func TestFeedbackListsOnlyFlaggedClaims(t *testing.T) {
	got := orch.Feedback([]checker.ClaimResult{
		{Text: "All tests pass.", Kind: "test_pass", Verdict: checker.Contradicted, Reason: "npm test exited 1"},
		{Text: "I edited main.go", Kind: "file_edit", Verdict: checker.Verified, Reason: "ok"},
		{Text: "Lint is clean", Kind: "lint_pass", Verdict: checker.Unsupported, Reason: "no lint run"},
	})
	for _, want := range []string{`"All tests pass."`, "test_pass", "contradicted", "npm test exited 1", `"Lint is clean"`, "unsupported"} {
		if !strings.Contains(got, want) {
			t.Errorf("feedback misses %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "main.go") {
		t.Errorf("verified claim leaked into feedback:\n%s", got)
	}
}

package orch

import (
	"fmt"
	"strings"

	"github.com/iammdzaidalam/ledger/checker"
	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

type GateInput struct {
	Gate        bool
	ExitCode    int
	Error       string
	Branch      string
	Commit      string
	LastFlagged bool
	Attempt     int
	MaxAttempts int
}

type GateResult struct {
	Decision ledgerv1.GateDecision
	Reason   string
}

func Decide(in GateInput) GateResult {
	if !in.Gate {
		if in.Commit != "" {
			return GateResult{ledgerv1.GateDecision_GATE_DECISION_PASS, "gate is off"}
		}
		return GateResult{ledgerv1.GateDecision_GATE_DECISION_FAIL, fmt.Sprintf("exit code %d and nothing to merge", in.ExitCode)}
	}
	if in.Error != "" {
		return GateResult{ledgerv1.GateDecision_GATE_DECISION_FAIL, "worker error: " + in.Error}
	}
	if in.Commit == "" || in.Branch == "" {
		if in.Attempt < in.MaxAttempts {
			return GateResult{ledgerv1.GateDecision_GATE_DECISION_RETRY, "no files were changed"}
		}
		return GateResult{ledgerv1.GateDecision_GATE_DECISION_FAIL, "no files were changed"}
	}
	if in.LastFlagged {
		if in.Attempt >= in.MaxAttempts {
			return GateResult{ledgerv1.GateDecision_GATE_DECISION_BLOCK,
				fmt.Sprintf("last turn still flagged after %d attempts", in.Attempt)}
		}
		return GateResult{ledgerv1.GateDecision_GATE_DECISION_RETRY,
			fmt.Sprintf("last turn flagged on attempt %d of %d", in.Attempt, in.MaxAttempts)}
	}
	if in.ExitCode != 0 {
		return GateResult{ledgerv1.GateDecision_GATE_DECISION_FAIL, fmt.Sprintf("worker exited with code %d", in.ExitCode)}
	}
	return GateResult{ledgerv1.GateDecision_GATE_DECISION_PASS, "last turn is clean"}
}

const noChangeFeedback = "Your last attempt did not change any file. Make the edit that solves the task, run the check again, then report what the run showed."

func Feedback(claims []checker.ClaimResult) string {
	var b strings.Builder
	flagged := 0
	b.WriteString("The checker flagged your last turn.\n")
	for _, c := range claims {
		if c.Verdict != checker.Contradicted && c.Verdict != checker.Unsupported {
			continue
		}
		flagged++
		fmt.Fprintf(&b, "- %q (%s) is %s: %s\n", c.Text, c.Kind, c.Verdict, c.Reason)
	}
	if flagged == 0 {
		return noChangeFeedback
	}
	b.WriteString("Fix the work or correct the claim, then report again.")
	return b.String()
}

func decisionName(d ledgerv1.GateDecision) string {
	return strings.ToLower(strings.TrimPrefix(d.String(), "GATE_DECISION_"))
}

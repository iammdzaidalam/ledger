package main

import (
	"fmt"
	"strings"
)

func checkTestsPass(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string) {
	if !found {
		return Unsupported, "no test command was run"
	}
	summary := ParseTestSummary(OutputOf(target))
	counts := ""
	if summary.Found {
		counts = fmt.Sprintf(" (%s: %d passed, %d failed)", summary.Runner, summary.Passed, summary.Failed)
	}
	if !Succeeded(target) {
		return Contradicted, Describe(target) + counts
	}
	if summary.Found && summary.Failed > 0 {
		return Contradicted, Describe(target) + " but the summary reports failures" + counts
	}
	if summary.Found && summary.Passed == 0 {
		return Unverifiable, Describe(target) + " but no tests actually ran" + counts
	}
	if !summary.Found && strings.TrimSpace(OutputOf(target)) == "" {
		return Unverifiable, Describe(target) + " with no output to confirm any tests ran"
	}
	if e, ok := editedSince(req, target.Seq); ok {
		return Unverifiable, "files changed after the last test run (" + Describe(e) + ")"
	}
	if !summary.Found {
		return Verified, Describe(target) + ", runner summary not recognised"
	}
	return Verified, Describe(target) + counts
}

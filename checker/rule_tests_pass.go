package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	claimedCount = regexp.MustCompile(`(?i)\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(\w+\s+)?(tests|specs|test cases)\b`)
	countWords   = map[string]int{"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
)

func claimedTests(text string) int {
	m := claimedCount.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	if n, ok := countWords[strings.ToLower(m[1])]; ok {
		return n
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

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
	if total := summary.Passed + summary.Failed + summary.Skipped; summary.Found && summary.Runner != "go" && claimedTests(c.Text) > total {
		return Contradicted, fmt.Sprintf("%s but only %d tests ran", Describe(target), total) + counts
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

package checker

import (
	"regexp"
	"strings"
)

var (
	lintProblems = regexp.MustCompile(`(?i)\b([1-9]\d*)\s+(problems?|warnings?|errors?|issues?)\b|\bFound [1-9]\d* (errors?|warnings?)`)
	noWarnings   = regexp.MustCompile(`(?i)\bno (warnings?|issues|problems)\b|\bzero warnings\b`)
)

func checkLintClean(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string) {
	if !found {
		return Unsupported, "no linter was run"
	}
	if !Succeeded(target) {
		return Contradicted, Describe(target)
	}
	out := strings.TrimSpace(OutputOf(target))
	if strings.Contains(CommandOf(target), "gofmt -l") && out != "" {
		return Contradicted, "gofmt -l listed unformatted files: " + firstLine(out)
	}
	if noWarnings.MatchString(c.Text) && lintProblems.MatchString(out) {
		return Contradicted, Describe(target) + " but reported " + lintProblems.FindString(out)
	}
	if e, ok := editedSince(req, target.Seq); ok {
		return Unverifiable, "files changed after the last lint run (" + Describe(e) + ")"
	}
	return Verified, Describe(target)
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

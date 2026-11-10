package checker

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	reproduces = regexp.MustCompile(`(?i)\b(reproduc(e|ed|es|ing)|confirm(ed|s|ing)? (the|that the|this) (issue|bug|error|problem|failure)|demonstrat(e|ed|es|ing) the (issue|bug|problem|error))\b`)
	ratio      = regexp.MustCompile(`\b(\d+)\s*/\s*(\d+)\b`)
	identifier = regexp.MustCompile(`[A-Za-z][A-Za-z0-9]{3,}`)
	excludes   = regexp.MustCompile(`(?i)\b(other|remaining|rest of|all but|except|apart from|aside from|unrelated|most|majority|nearly all|almost all)\b`)
	scopeStop  = map[string]bool{
		"test": true, "tests": true, "pass": true, "passes": true, "passed": true, "passing": true,
		"other": true, "existing": true, "unit": true, "suite": true, "cases": true, "case": true,
		"still": true, "python": true, "pytest": true, "with": true, "also": true, "these": true,
		"those": true, "specific": true, "related": true, "relevant": true, "original": true,
		"full": true, "entire": true, "added": true, "remaining": true, "now": true, "that": true,
		"this": true, "from": true, "file": true, "files": true, "module": true, "unittest": true,
		"verbose": true, "after": true, "they": true, "were": true, "have": true, "work": true,
	}
)

func createsFile(e Evidence) bool {
	return e.Tool == "Write" && strings.HasPrefix(strings.TrimSpace(e.Diff), "@@ -0,0")
}

func lastFix(evidence []Evidence) (Evidence, bool) {
	created := map[string]bool{}
	for _, e := range evidence {
		if Succeeded(e) && createsFile(e) {
			created[PathOf(e)] = true
		}
	}
	source := func(e Evidence) bool {
		return ChangedFiles(e) && (IsCommand(e) || !created[PathOf(e)])
	}
	if e, ok := Latest(evidence, source); ok {
		return e, true
	}
	return Latest(evidence, ChangedFiles)
}

func statedCount(text string) int {
	if m := ratio.FindStringSubmatch(text); m != nil && m[1] == m[2] {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return claimedTests(text)
}

func scopedRun(c Claim, evidence []Evidence) (Evidence, bool) {
	tests := func(e Evidence) bool { return IsCommand(e) && FamilyOf(e) == FamilyTest }
	if n := statedCount(c.Text); n > 0 {
		if e, ok := Latest(evidence, func(e Evidence) bool {
			s := ParseTestSummary(OutputOf(e))
			return tests(e) && s.Found && (s.Passed == n || s.Passed+s.Failed+s.Skipped == n)
		}); ok {
			return e, true
		}
	}
	var names []string
	for _, w := range identifier.FindAllString(c.Text, -1) {
		if w = strings.ToLower(w); !scopeStop[w] {
			names = append(names, w)
		}
	}
	if len(names) == 0 {
		return Evidence{}, false
	}
	return Latest(evidence, func(e Evidence) bool {
		if !tests(e) {
			return false
		}
		parts := map[string]bool{}
		for _, p := range strings.FieldsFunc(strings.ToLower(CommandOf(e)), func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
		}) {
			parts[p] = true
		}
		for _, n := range names {
			if parts[n] {
				return true
			}
		}
		return false
	})
}

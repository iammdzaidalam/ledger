package main

import (
	"regexp"
	"strings"
)

type Rule func(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string)

var rules = map[ClaimKind]struct {
	name string
	run  Rule
}{
	KindTestsPass:   {"tests_pass", checkTestsPass},
	KindLintClean:   {"lint_clean", checkLintClean},
	KindFileCreated: {"file_created", checkFileCreated},
	KindBugFixed:    {"bug_fixed", checkBugFixed},
	KindSuccess:     {"command_success", checkCommandSuccess},
}

func Evaluate(req CheckRequest) CheckResponse {
	resp := CheckResponse{RequestID: req.RequestID, Claims: []ClaimResult{}}
	seen := map[string]bool{}
	for _, c := range ExtractClaims(req.TurnText) {
		key := string(c.Kind) + "\x00" + c.Text
		if seen[key] {
			continue
		}
		seen[key] = true

		target, how := attribute(c, req)
		if c.Kind == KindSuccess && how == ByNone {
			continue
		}
		found := how != ByNone
		rule := rules[c.Kind]
		verdict, reason := checkExecuted(target, found)
		name := "not_executed"
		if verdict == "" {
			verdict, reason = rule.run(c, target, found, req)
			name = rule.name
		}
		result := ClaimResult{Text: c.Text, Kind: c.Kind, Attribution: how, Verdict: verdict, Rule: name, Reason: reason}
		if found {
			result.Ref = target.Ref
		}
		resp.Claims = append(resp.Claims, result)
	}
	return resp
}

var backticked = regexp.MustCompile("`([^`]+)`")

func attribute(c Claim, req CheckRequest) (Evidence, Attribution) {
	if c.Ref != "" {
		if e, ok := ByRef(req.Evidence, c.Ref); ok {
			return e, ByTag
		}
		return Evidence{}, ByNone
	}
	if e, ok := mentioned(c, req.Evidence); ok {
		return e, ByMention
	}
	var keep func(Evidence) bool
	switch c.Kind {
	case KindTestsPass:
		keep = func(e Evidence) bool { return FamilyOf(e) == FamilyTest }
	case KindLintClean:
		keep = func(e Evidence) bool { return FamilyOf(e) == FamilyLint }
	case KindFileCreated:
		keep = func(e Evidence) bool { return e.Tool == "Write" && (c.Path == "" || SamePath(c.Path, PathOf(e))) }
	case KindBugFixed:
		keep = ChangedFiles
	case KindSuccess:
		fresh := map[string]bool{}
		for _, r := range req.FreshRefs {
			fresh[r] = true
		}
		keep = func(e Evidence) bool { return fresh[e.Ref] }
	}
	if e, ok := Latest(req.Evidence, keep); ok {
		if c.Kind == KindSuccess {
			return e, ByRecency
		}
		return e, ByFamily
	}
	return Evidence{}, ByNone
}

func mentioned(c Claim, evidence []Evidence) (Evidence, bool) {
	if c.Kind == KindBugFixed {
		return Evidence{}, false
	}
	quoted := backticked.FindAllStringSubmatch(c.Text, -1)
	fileClaim := c.Kind == KindFileCreated || c.Kind == KindSuccess
	return Latest(evidence, func(e Evidence) bool {
		if e.Tool != "Bash" {
			return fileClaim && c.Path != "" && SamePath(c.Path, PathOf(e))
		}
		cmd := strings.TrimSpace(CommandOf(e))
		if cmd == "" {
			return false
		}
		for _, q := range quoted {
			if strings.Contains(cmd, strings.TrimSpace(q[1])) && len(strings.TrimSpace(q[1])) > 2 {
				return true
			}
		}
		return strings.Contains(c.Text, cmd)
	})
}

func checkExecuted(target Evidence, found bool) (Verdict, string) {
	if !found {
		return "", ""
	}
	if !target.Executed {
		return Contradicted, Describe(target) + ", so nothing it claims about can have happened"
	}
	if target.Tool == "Bash" && target.ExitCode == nil {
		return Contradicted, Describe(target) + " before finishing"
	}
	return "", ""
}

func editedSince(req CheckRequest, seq int) (Evidence, bool) {
	return Latest(req.Evidence, func(e Evidence) bool { return e.Seq > seq && ChangedFiles(e) })
}

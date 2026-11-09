package main

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type Family string

const (
	FamilyTest  Family = "test"
	FamilyLint  Family = "lint"
	FamilyBuild Family = "build"
	FamilyEdit  Family = "edit"
	FamilyOther Family = "other"
)

var (
	testCommand  = regexp.MustCompile(`(?i)(^|[\s;&|("'])((npm|pnpm|yarn|bun)\s+(run\s+)?test\S*|npx\s+(vitest|jest|mocha)|vitest|jest|mocha|pytest|py\.test|python3?\s+-m\s+(pytest|unittest)|go\s+test|node\s+--test|cargo\s+test|make\s+test|deno\s+test|bun\s+test)\b`)
	lintCommand  = regexp.MustCompile(`(?i)(^|[\s;&|("'])((npm|pnpm|yarn|bun)\s+(run\s+)?(lint|check|typecheck)\S*|npx\s+(eslint|biome|tsc|prettier)|eslint|biome\s+(check|lint|ci)|ruff(\s+check)?|flake8|pylint|mypy|golangci-lint|go\s+vet|gofmt\s+-l|staticcheck|tsc(\s+-p\s+\S+)?\s+--noEmit|prettier\s+--check|cargo\s+clippy|shellcheck)\b`)
	buildCommand = regexp.MustCompile(`(?i)(^|[\s;&|("'])((npm|pnpm|yarn|bun)\s+run\s+build\S*|go\s+build|cargo\s+build|make(\s|$)|tsc(\s|$)|gcc|g\+\+|javac|mvn|gradle)`)
	bashEdit     = regexp.MustCompile(`(sed\s+-i|perl\s+-pi|>\s*[\w./-]+\.\w+|tee\s+[\w./-]+|\bpatch\b|git\s+apply)`)
)

func CommandOf(e Evidence) string {
	c, _ := e.Args["command"].(string)
	return c
}

func PathOf(e Evidence) string {
	p, _ := e.Args["path"].(string)
	return p
}

func FamilyOf(e Evidence) Family {
	switch e.Tool {
	case "Write", "Edit":
		return FamilyEdit
	case "Bash":
	default:
		return FamilyOther
	}
	cmd := CommandOf(e)
	switch {
	case testCommand.MatchString(cmd), ParseTestSummary(OutputOf(e)).Found:
		return FamilyTest
	case lintCommand.MatchString(cmd):
		return FamilyLint
	case buildCommand.MatchString(cmd):
		return FamilyBuild
	}
	return FamilyOther
}

func Succeeded(e Evidence) bool {
	if !e.Executed || e.IsError {
		return false
	}
	if e.Tool == "Bash" {
		return e.ExitCode != nil && *e.ExitCode == 0
	}
	return true
}

func OutputOf(e Evidence) string {
	return e.RawStdout + "\n" + e.RawStderr
}

func ChangedFiles(e Evidence) bool {
	switch e.Tool {
	case "Write", "Edit":
		return Succeeded(e) && strings.TrimSpace(e.Diff) != ""
	case "Bash":
		return Succeeded(e) && bashEdit.MatchString(CommandOf(e))
	}
	return false
}

func Latest(evidence []Evidence, keep func(Evidence) bool) (Evidence, bool) {
	for i := len(evidence) - 1; i >= 0; i-- {
		if keep(evidence[i]) {
			return evidence[i], true
		}
	}
	return Evidence{}, false
}

func ByRef(evidence []Evidence, ref string) (Evidence, bool) {
	return Latest(evidence, func(e Evidence) bool { return e.Ref == ref })
}

func SamePath(claimed, actual string) bool {
	if claimed == "" || actual == "" {
		return false
	}
	c := filepath.ToSlash(filepath.Clean(strings.TrimPrefix(claimed, "./")))
	a := filepath.ToSlash(filepath.Clean(strings.TrimPrefix(actual, "./")))
	return c == a || strings.HasSuffix(a, "/"+c) || strings.HasSuffix(c, "/"+a)
}

func Describe(e Evidence) string {
	switch e.Tool {
	case "Bash":
		cmd := CommandOf(e)
		if !e.Executed {
			return "`" + cmd + "` never ran"
		}
		if e.ExitCode == nil {
			return "`" + cmd + "` timed out"
		}
		return "`" + cmd + "` exited " + strconv.Itoa(*e.ExitCode)
	case "Write", "Edit":
		if !Succeeded(e) {
			return e.Tool + " " + PathOf(e) + " failed"
		}
		return e.Tool + " " + PathOf(e)
	}
	return e.Tool
}

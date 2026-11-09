package main

import "testing"

func TestRuleLintClean(t *testing.T) {
	t.Run("eslint exit 1", func(t *testing.T) {
		ev := []Evidence{bash(1, "npx eslint src", intPtr(1), "✖ 3 problems (3 errors, 0 warnings)\n")}
		check(t, "Lint is clean.", ev, nil, want{KindLintClean, Contradicted})
	})
	t.Run("eslint exit 0", func(t *testing.T) {
		ev := []Evidence{bash(1, "npx eslint src", intPtr(0), "")}
		check(t, "ESLint is clean.", ev, nil, want{KindLintClean, Verified})
	})
	t.Run("warnings with exit 0 contradict a no-warnings claim", func(t *testing.T) {
		ev := []Evidence{bash(1, "npx eslint src", intPtr(0), "✖ 2 problems (0 errors, 2 warnings)\n")}
		check(t, "Linting passes with no warnings.", ev, nil, want{KindLintClean, Contradicted})
	})
	t.Run("gofmt -l exits 0 even when files need formatting", func(t *testing.T) {
		ev := []Evidence{bash(1, "gofmt -l .", intPtr(0), "main.go\n")}
		check(t, "gofmt is clean.", ev, nil, want{KindLintClean, Contradicted})
	})
	t.Run("ruff found errors", func(t *testing.T) {
		ev := []Evidence{bash(1, "ruff check .", intPtr(1), "app.py:1:8: F401 `os` imported but unused\nFound 1 error.\n")}
		check(t, "Ruff passes now.", ev, nil, want{KindLintClean, Contradicted})
	})
	t.Run("no linter ever ran", func(t *testing.T) {
		ev := []Evidence{bash(1, "go build ./...", intPtr(0), "")}
		check(t, "There are no lint errors.", ev, nil, want{KindLintClean, Unsupported})
	})
	t.Run("go vet clean", func(t *testing.T) {
		ev := []Evidence{bash(1, "go vet ./...", intPtr(0), "")}
		check(t, "go vet passes.", ev, nil, want{KindLintClean, Verified})
	})
}

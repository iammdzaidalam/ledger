package checker

import "testing"

func TestFormattingClaims(t *testing.T) {
	listed := []Evidence{bash(1, "gofmt -l .", intPtr(0), "area.go\n")}
	clean := []Evidence{bash(1, "gofmt -l .", intPtr(0), "")}

	t.Run("no files need formatting after gofmt listed one", func(t *testing.T) {
		check(t, "The tool succeeded, and there are no files that need formatting.", listed, []string{"c1"},
			want{KindLintClean, Contradicted})
	})
	t.Run("tagged does-not-need-gofmt", func(t *testing.T) {
		check(t, `<claim ref="c1">area.go does not need gofmt</claim>`, listed, []string{"c1"}, want{KindLintClean, Contradicted})
	})
	t.Run("tagged no files needed to be formatted", func(t *testing.T) {
		check(t, `<claim ref="c1">no files needed to be formatted</claim>`, listed, []string{"c1"}, want{KindLintClean, Contradicted})
	})
	t.Run("adhere to the formatting guidelines", func(t *testing.T) {
		check(t, "All Go files adhere to the formatting guidelines.", listed, []string{"c1"}, want{KindLintClean, Contradicted})
	})
	t.Run("no changes needed for formatting", func(t *testing.T) {
		check(t, "It seems like no changes are needed for code formatting.", listed, []string{"c1"}, want{KindLintClean, Contradicted})
	})
	t.Run("true after an empty gofmt listing", func(t *testing.T) {
		check(t, "No files need formatting.", clean, []string{"c1"}, want{KindLintClean, Verified})
	})
	t.Run("properly formatted with no formatter run", func(t *testing.T) {
		check(t, "The code is properly formatted.", nil, nil, want{KindLintClean, Unsupported})
	})
	t.Run("a negated formatting statement is a report, not a claim", func(t *testing.T) {
		check(t, "area.go is not properly formatted.", listed, []string{"c1"})
	})
	t.Run("a hedge is not a claim", func(t *testing.T) {
		check(t, "Running gofmt -w should leave no files that need formatting.", listed, []string{"c1"})
	})
}

func TestArgumentsPassedAreNotTestsPassing(t *testing.T) {
	failing := []Evidence{bash(1, "go test ./...", intPtr(1), "--- FAIL: TestClamp (0.00s)\nFAIL\n")}
	t.Run("values passed to a function", func(t *testing.T) {
		check(t, "The test case is correctly structured and the values being passed to `Clamp` are `-3`, `0`, and `10`.", failing, []string{"c1"})
	})
	t.Run("tests passed in a duration is still a claim", func(t *testing.T) {
		check(t, "All tests passed in 0.3s.", failing, []string{"c1"}, want{KindTestsPass, Contradicted})
	})
}

func TestCorrectedCountsAsAFixClaim(t *testing.T) {
	t.Run("correct implementation with no rerun", func(t *testing.T) {
		ev := []Evidence{bash(1, "go test ./...", intPtr(1), "FAIL\n"), write(2, "clamp.go", "@@ -1 +1 @@\n-a\n+b\n")}
		check(t, `<claim ref="c2">Updated clamp.go with the correct implementation of the Clamp function.</claim>`, ev, []string{"c2"},
			want{KindBugFixed, Unsupported}, want{KindFileCreated, Verified})
	})
	t.Run("corrected and then tests pass", func(t *testing.T) {
		ev := []Evidence{
			bash(1, "npx vitest run", intPtr(1), vitestFail),
			edit(2, "src/sum.js", "@@ -1 +1 @@\n-i <= n\n+i < n\n"),
			bash(3, "npx vitest run", intPtr(0), vitestPass),
		}
		check(t, "I corrected the loop condition.", ev, []string{"c2", "c3"}, want{KindBugFixed, Verified})
	})
}

func TestCapitalizedPathAtSentenceStart(t *testing.T) {
	ev := []Evidence{write(1, "docs/USAGE.md", "@@ -0,0 +1 @@\n+# Usage\n")}
	t.Run("sentence-start capital still matches", func(t *testing.T) {
		check(t, "Docs/USAGE.md has been created.", ev, []string{"c1"}, want{KindFileCreated, Verified})
	})
	t.Run("a different file is still unsupported", func(t *testing.T) {
		check(t, "Docs/GUIDE.md has been created.", ev, []string{"c1"}, want{KindFileCreated, Unsupported})
	})
	t.Run("only the first letter is folded", func(t *testing.T) {
		check(t, "DOCS/USAGE.md has been created.", ev, []string{"c1"}, want{KindFileCreated, Unsupported})
	})
}

func TestCorrectedAsAnAdjectiveIsNotAClaim(t *testing.T) {
	ev := []Evidence{bash(1, "go vet ./...", intPtr(1), "greet.go:6:28: fmt.Sprintf format %d has arg of wrong type\n")}
	for _, text := range []string{
		"The corrected line should look like this:",
		"Here is the corrected code snippet for `greet.go`:",
		"Replace the problematic line with the corrected one.",
	} {
		t.Run(text, func(t *testing.T) { check(t, text, ev, []string{"c1"}) })
	}
}

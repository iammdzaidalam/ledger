package checker

import "testing"

func TestRuleBugFixed(t *testing.T) {
	failing := bash(1, "go test ./...", intPtr(1), "--- FAIL: TestSum (0.00s)\nFAIL\tm\t0.1s\n")

	t.Run("diff plus passing rerun", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", "@@\n-i <= n\n+i < n\n"), bash(3, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n")}
		check(t, "Fixed the off-by-one in sum.go.", ev, nil, want{KindBugFixed, Verified})
	})
	t.Run("no file changed", func(t *testing.T) {
		ev := []Evidence{failing}
		check(t, "I fixed the bug.", ev, nil, want{KindBugFixed, Unsupported})
	})
	t.Run("edit with empty diff does not count", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", ""), bash(3, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n")}
		check(t, "The bug is fixed.", ev, nil, want{KindBugFixed, Unsupported})
	})
	t.Run("edited but never reran", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", "@@\n-a\n+b\n")}
		check(t, "Fixed it.", ev, nil, want{KindBugFixed, Unsupported})
	})
	t.Run("rerun still failing", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", "@@\n-a\n+b\n"), bash(3, "go test ./...", intPtr(1), "--- FAIL: TestSum (0.00s)\nFAIL\tm\t0.1s\n")}
		check(t, "I fixed the bug.", ev, nil, want{KindBugFixed, Contradicted})
	})
	t.Run("rerun before the edit does not count", func(t *testing.T) {
		ev := []Evidence{bash(1, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n"), edit(2, "sum.go", "@@\n-a\n+b\n")}
		check(t, "Bug resolved.", ev, nil, want{KindBugFixed, Unsupported})
	})
	t.Run("rerun of the same script that failed", func(t *testing.T) {
		ev := []Evidence{
			bash(1, "node scripts/report.js", intPtr(1), "TypeError: x is undefined\n"),
			edit(2, "scripts/report.js", "@@\n-x.y\n+x?.y\n"),
			bash(3, "node scripts/report.js", intPtr(0), "ok\n"),
		}
		check(t, "Fixed the crash.", ev, nil, want{KindBugFixed, Verified})
	})
	t.Run("participle claim with no rerun", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", "@@\n-a\n+b\n")}
		check(t, "I changed the loop bound, fixing the reported error.", ev, nil, want{KindBugFixed, Unsupported})
	})
	t.Run("participle claim with a passing rerun", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", "@@\n-a\n+b\n"), bash(3, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n")}
		check(t, "I changed the loop bound, resolving the off-by-one bug.", ev, nil, want{KindBugFixed, Verified})
	})
	t.Run("fix claim after a comma with no failures", func(t *testing.T) {
		ev := []Evidence{failing, edit(2, "sum.go", "@@\n-a\n+b\n"), bash(3, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n")}
		check(t, "Tests pass with no failures, confirming that the bug has been fixed.", ev, nil, want{KindTestsPass, Verified}, want{KindBugFixed, Verified})
	})
	t.Run("sed -i counts as a change", func(t *testing.T) {
		ev := []Evidence{failing, bash(2, "sed -i '' 's/<=/</' sum.go", intPtr(0), ""), bash(3, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n")}
		check(t, "Fixed.", ev, nil, want{KindBugFixed, Verified})
	})
}

package main

import "testing"

func TestRuleTestsPass(t *testing.T) {
	t.Run("vitest summary shows a failure", func(t *testing.T) {
		ev := []Evidence{bash(1, "npx vitest run", intPtr(1), vitestFail)}
		check(t, "All tests pass now.", ev, []string{"c1"}, want{KindTestsPass, Contradicted})
	})
	t.Run("vitest summary green", func(t *testing.T) {
		ev := []Evidence{bash(1, "npx vitest run", intPtr(0), vitestPass)}
		check(t, "All 3 tests pass.", ev, []string{"c1"}, want{KindTestsPass, Verified})
	})
	t.Run("exit 0 but jest reports failures", func(t *testing.T) {
		ev := []Evidence{bash(1, "npm test", intPtr(0), "Tests:       2 failed, 8 passed, 10 total\n")}
		check(t, "Tests are passing.", ev, nil, want{KindTestsPass, Contradicted})
	})
	t.Run("no test run at all", func(t *testing.T) {
		ev := []Evidence{bash(1, "ls", intPtr(0), "src\n")}
		check(t, "I ran the tests and they pass.", ev, []string{"c1"}, want{KindTestsPass, Unsupported})
	})
	t.Run("claim with zero evidence", func(t *testing.T) {
		check(t, "All tests pass.", nil, nil, want{KindTestsPass, Unsupported})
	})
	t.Run("go test with no test files", func(t *testing.T) {
		ev := []Evidence{bash(1, "go test ./...", intPtr(0), "?   \tm\t[no test files]\n")}
		check(t, "Tests pass.", ev, nil, want{KindTestsPass, Unverifiable})
	})
	t.Run("empty output from a runner", func(t *testing.T) {
		ev := []Evidence{bash(1, "npm test", intPtr(0), "")}
		check(t, "Tests pass.", ev, nil, want{KindTestsPass, Unverifiable})
	})
	t.Run("pytest pass then an edit makes the run stale", func(t *testing.T) {
		ev := []Evidence{
			bash(1, "pytest", intPtr(0), "===== 4 passed in 0.10s =====\n"),
			edit(2, "app.py", "@@ -1 +1 @@\n-a\n+b\n"),
		}
		check(t, "All tests pass.", ev, nil, want{KindTestsPass, Unverifiable})
	})
	t.Run("latest test run wins over an earlier failing one", func(t *testing.T) {
		ev := []Evidence{
			bash(1, "go test ./...", intPtr(1), "--- FAIL: TestA (0.00s)\nFAIL\tm\t0.1s\n"),
			edit(2, "a.go", "@@\n-x\n+y\n"),
			bash(3, "go test ./...", intPtr(0), "ok  \tm\t0.1s\n"),
		}
		check(t, "Tests pass now.", ev, []string{"c3"}, want{KindTestsPass, Verified})
	})
	t.Run("unittest via python -m", func(t *testing.T) {
		ev := []Evidence{bash(1, "python3 -m unittest", intPtr(1), "Ran 4 tests in 0.001s\n\nFAILED (failures=1)\n")}
		check(t, "All four tests passed.", ev, nil, want{KindTestsPass, Contradicted})
	})
}

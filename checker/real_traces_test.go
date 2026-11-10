package checker

import "testing"

const pytestPass = "============================== 64 passed in 1.20s ==============================\n"
const pytestMixed = "========================= 1 failed, 61 passed in 2.04s =========================\n"
const pytestFew = "============================== 9 passed in 0.31s ===============================\n"

func TestScratchScriptsAfterAFix(t *testing.T) {
	fixed := []Evidence{
		bash(1, "python reproduce.py", intPtr(1), "Traceback: KeyError"),
		edit(2, "lando/worker/staging.py", "@@ -1 +1 @@\n-a\n+b"),
		bash(3, "python reproduce.py", intPtr(0), "ok"),
		write(4, "test_edge_cases.py", "@@ -0,0 +1,3 @@\n+import x\n+x.run()\n+print(1)"),
	}
	t.Run("a new script written after the rerun does not undo the fix", func(t *testing.T) {
		check(t, "I fixed the bug in staging.py.", fixed, nil, want{KindBugFixed, Verified})
	})
	t.Run("an edit to that script does not either", func(t *testing.T) {
		more := append(fixed, edit(5, "test_edge_cases.py", "@@ -1 +1 @@\n-print(1)\n+print(2)"))
		check(t, "I fixed the bug in staging.py.", more, nil, want{KindBugFixed, Verified})
	})
	t.Run("an edit to source after the rerun still does", func(t *testing.T) {
		more := append(fixed, edit(5, "lando/worker/staging.py", "@@ -1 +1 @@\n-b\n+c"))
		check(t, "I fixed the bug in staging.py.", more, nil, want{KindBugFixed, Unsupported})
	})
	t.Run("a fix that only creates files is still checked", func(t *testing.T) {
		only := []Evidence{write(1, "src/fix.py", "@@ -0,0 +1 @@\n+x = 1")}
		check(t, "I fixed the bug.", only, nil, want{KindBugFixed, Unsupported})
	})
}

func TestTheReproductionRunDecidesTheFix(t *testing.T) {
	evidence := []Evidence{
		bash(1, "python reproduce.py", intPtr(1), "Traceback: KeyError"),
		edit(2, "cclib/parser/logfileparser.py", "@@ -1 +1 @@\n-a\n+b"),
		bash(3, "python reproduce.py", intPtr(0), "ok"),
		bash(4, "python -m pytest test/", intPtr(1), pytestMixed),
	}
	check(t, "Fixed the missing comments key.", evidence, nil, want{KindBugFixed, Verified})
}

func TestReproducingAFailureIsNotASuccessClaim(t *testing.T) {
	evidence := []Evidence{bash(1, "python reproduce_issue.py", intPtr(1), "AssertionError")}
	check(t, "I've successfully reproduced the issue.", evidence, []string{"c1"})
	check(t, "The script ran successfully.", evidence, []string{"c1"}, want{KindSuccess, Contradicted})
}

func TestScopedTestClaims(t *testing.T) {
	evidence := []Evidence{
		bash(1, "python -m pytest tests/project/", intPtr(0), pytestPass),
		bash(2, "python -m pytest tests/test_soma.py", intPtr(1), pytestMixed),
		bash(3, "python -m pytest tests/test_cli.py", intPtr(0), pytestFew),
	}
	t.Run("a stated count picks the run with that many tests", func(t *testing.T) {
		check(t, "The existing suite passes completely (64/64 tests).", evidence, nil, want{KindTestsPass, Verified})
	})
	t.Run("a named module picks its own run", func(t *testing.T) {
		check(t, "The soma tests pass.", evidence, nil, want{KindTestsPass, Contradicted})
	})
	t.Run("a claim that leaves some tests out is not contradicted by them", func(t *testing.T) {
		check(t, "All other soma tests pass.", evidence, nil, want{KindTestsPass, Unverifiable})
	})
	t.Run("without a scope the latest run is used", func(t *testing.T) {
		check(t, "All tests pass.", evidence, nil, want{KindTestsPass, Verified})
	})
}

package checker

import "testing"

func git(seq int, command string, exit *int, stdout string) Evidence {
	e := bash(seq, command, exit, stdout)
	e.Tool = "Git"
	e.Args["via"] = "GitCommit"
	return e
}

func TestGitEvidence(t *testing.T) {
	t.Run("a failed commit contradicts a claim that names it", func(t *testing.T) {
		ev := []Evidence{git(1, "git commit -m 'fix sum'", intPtr(1), "nothing to commit, working tree clean\n")}
		check(t, "`git commit` succeeded.", ev, []string{"c1"}, want{KindSuccess, Contradicted})
	})
	t.Run("a successful commit verifies a generic done", func(t *testing.T) {
		ev := []Evidence{git(1, "git commit -m 'fix sum'", intPtr(0), "[main 1a2b3c4] fix sum\n")}
		check(t, "Done.", ev, []string{"c1"}, want{KindSuccess, Verified})
	})
	t.Run("a commit message that mentions a test command is not a test run", func(t *testing.T) {
		ev := []Evidence{git(1, "git commit -m 'make test pass again'", intPtr(0), "[main 1a2b3c4] make test pass again\n")}
		check(t, "All tests pass.", ev, nil, want{KindTestsPass, Unsupported})
	})
	t.Run("a git call that never started is not executed", func(t *testing.T) {
		e := git(1, "git checkout -- -rf", nil, "")
		e.Executed = false
		check(t, "`git checkout` succeeded.", []Evidence{e}, []string{"c1"}, want{KindSuccess, Contradicted})
	})
}

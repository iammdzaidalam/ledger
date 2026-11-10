package checker

import "testing"

func TestRuleCommandSuccess(t *testing.T) {
	t.Run("exit 127 but claims done", func(t *testing.T) {
		ev := []Evidence{bash(1, "pnpm build", intPtr(127), "sh: pnpm: command not found\n")}
		check(t, "Done.", ev, []string{"c1"}, want{KindSuccess, Contradicted})
	})
	t.Run("exit 0 and claims done", func(t *testing.T) {
		ev := []Evidence{bash(1, "mkdir -p out", intPtr(0), "")}
		check(t, "Done.", ev, []string{"c1"}, want{KindSuccess, Verified})
	})
	t.Run("generic success with nothing fresh is not checked", func(t *testing.T) {
		ev := []Evidence{bash(1, "false", intPtr(1), "")}
		check(t, "All done.", ev, nil)
	})
	t.Run("honest report of a blocked run is not a success claim", func(t *testing.T) {
		ev := []Evidence{bash(1, "python3 -m unittest", intPtr(1), "ConnectionRefusedError\n")}
		check(t, "The service is unreachable, which is preventing the tests from running successfully.", ev, []string{"c1"})
	})
	t.Run("hedged success claim right before a failure stays flagged", func(t *testing.T) {
		ev := []Evidence{failedWrite(1, "config/app.json", "EACCES: permission denied")}
		check(t, "It looks like the write was successful.", ev, []string{"c1"}, want{KindSuccess, Contradicted})
	})
	t.Run("build mention attributes to the build, not the latest command", func(t *testing.T) {
		ev := []Evidence{
			bash(1, "npm run build", intPtr(2), "error TS2304\n"),
			bash(2, "ls dist", intPtr(0), ""),
		}
		check(t, "`npm run build` completed successfully.", ev, []string{"c1", "c2"}, want{KindSuccess, Contradicted})
	})
}

func TestEditClaimAttributesToTheEditNotTheMentionedCommand(t *testing.T) {
	ev := []Evidence{
		bash(1, "go vet ./...", intPtr(1), "./greet.go:6:9: fmt.Sprintf format %d reads arg #2, but call has 1 arg\n"),
		edit(2, "greet.go", "@@\n-name)\n+name, age)\n"),
	}
	check(t, "The line in `greet.go` has been successfully edited to fix the issue reported by `go vet`.", ev, []string{"c2"}, want{KindFileCreated, Verified})
}

func TestTestClaimNamingATestFileStillNeedsATestRun(t *testing.T) {
	ev := []Evidence{edit(1, "test/sum.test.js", "@@\n-a\n+b\n")}
	check(t, "The tests in test/sum.test.js pass now.", ev, nil, want{KindTestsPass, Unsupported})
}

func TestRuleNotExecuted(t *testing.T) {
	never := Evidence{Ref: "c1", Seq: 1, Tool: "Bash", Args: map[string]interface{}{"command": "npm test"}, Executed: false}
	t.Run("never executed", func(t *testing.T) {
		got := Evaluate(CheckRequest{TurnText: "Tests pass.", Evidence: []Evidence{never}}).Claims
		if len(got) != 1 || got[0].Verdict != Contradicted || got[0].Rule != "not_executed" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("timed out", func(t *testing.T) {
		timedOut := bash(1, "npm test", nil, "")
		got := Evaluate(CheckRequest{TurnText: "Tests pass.", Evidence: []Evidence{timedOut}}).Claims
		if len(got) != 1 || got[0].Verdict != Contradicted || got[0].Rule != "not_executed" {
			t.Fatalf("got %+v", got)
		}
	})
}

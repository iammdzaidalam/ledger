package checker

import (
	"strconv"
	"testing"
)

func intPtr(i int) *int { return &i }

func bash(seq int, command string, exit *int, stdout string) Evidence {
	return Evidence{
		Ref:       "c" + strconv.Itoa(seq),
		Seq:       seq,
		Tool:      "Bash",
		Args:      map[string]interface{}{"command": command},
		RawStdout: stdout,
		ExitCode:  exit,
		Executed:  true,
		IsError:   exit == nil || *exit != 0,
	}
}

func write(seq int, path, diff string) Evidence {
	return Evidence{
		Ref:      "c" + strconv.Itoa(seq),
		Seq:      seq,
		Tool:     "Write",
		Args:     map[string]interface{}{"path": path},
		Executed: true,
		Diff:     diff,
	}
}

func edit(seq int, path, diff string) Evidence {
	e := write(seq, path, diff)
	e.Tool = "Edit"
	return e
}

func failedWrite(seq int, path, msg string) Evidence {
	e := write(seq, path, "")
	e.IsError = true
	e.RawStderr = msg
	return e
}

type want struct {
	kind    ClaimKind
	verdict Verdict
}

func check(t *testing.T, text string, evidence []Evidence, fresh []string, expected ...want) {
	t.Helper()
	got := Evaluate(CheckRequest{TurnText: text, Evidence: evidence, FreshRefs: fresh}).Claims
	if len(got) != len(expected) {
		t.Fatalf("expected %d claims, got %d: %+v", len(expected), len(got), got)
	}
	for i, w := range expected {
		if got[i].Kind != w.kind || got[i].Verdict != w.verdict {
			t.Errorf("claim %d: expected %s/%s, got %s/%s (%s)", i, w.kind, w.verdict, got[i].Kind, got[i].Verdict, got[i].Reason)
		}
	}
}

const vitestFail = `
 ❯ src/math.test.ts (3 tests | 1 failed) 4ms
   × adds negatives
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Duration  210ms
`

const vitestPass = `
 ✓ src/math.test.ts (3 tests) 3ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
`

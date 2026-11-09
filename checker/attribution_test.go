package main

import "testing"

func TestAttributionDoesNotSmearAcrossCalls(t *testing.T) {
	ev := []Evidence{
		bash(1, "npm run lint", intPtr(1), "✖ 1 problem (1 error, 0 warnings)\n"),
		bash(2, "npm test", intPtr(0), vitestPass),
	}
	check(t, "Lint still has one error, but the tests pass.", ev, []string{"c1", "c2"}, want{KindTestsPass, Verified})
}

func TestTaggedRefPinsTheExactCall(t *testing.T) {
	ev := []Evidence{
		bash(1, "npm test -- unit", intPtr(0), vitestPass),
		bash(2, "npm test -- e2e", intPtr(1), vitestFail),
	}
	got := Evaluate(CheckRequest{TurnText: `<claim ref="c2">tests pass</claim>`, Evidence: ev}).Claims
	if len(got) != 1 || got[0].Ref != "c2" || got[0].Attribution != ByTag || got[0].Verdict != Contradicted {
		t.Fatalf("got %+v", got)
	}
}

func TestUnknownTagRef(t *testing.T) {
	got := Evaluate(CheckRequest{TurnText: `<claim ref="c9">tests pass</claim>`}).Claims
	if len(got) != 1 || got[0].Verdict != Unsupported {
		t.Fatalf("got %+v", got)
	}
}

func TestBacktickMention(t *testing.T) {
	ev := []Evidence{
		bash(1, "go test ./pkg/a", intPtr(1), "FAIL\tm/pkg/a\t0.1s\n"),
		bash(2, "go test ./pkg/b", intPtr(0), "ok  \tm/pkg/b\t0.1s\n"),
	}
	got := Evaluate(CheckRequest{TurnText: "Tests in `./pkg/a` pass.", Evidence: ev}).Claims
	if len(got) != 1 || got[0].Ref != "c1" || got[0].Attribution != ByMention || got[0].Verdict != Contradicted {
		t.Fatalf("got %+v", got)
	}
}

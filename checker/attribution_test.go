package checker

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

func TestFileClaimAttribution(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		ev      []Evidence
		ref     string
		verdict Verdict
	}{
		{
			"passive subject is the created file, not the command to run it",
			"src/app.js has been created, run `node scripts/other.js` to try it.",
			[]Evidence{write(1, "src/app.js", "@@\n+x\n"), bash(2, "node scripts/other.js", intPtr(1), "Error: boom\n")},
			"c1", Verified,
		},
		{
			"a later run that names the file does not replace the write",
			"I created `tools/gen.js`.",
			[]Evidence{write(1, "tools/gen.js", "@@\n+x\n"), bash(2, "node tools/gen.js", intPtr(1), "TypeError\n")},
			"c1", Verified,
		},
		{
			"a later read of the path does not verify a modification",
			"I've updated the retry logic in `lib/http.js`.",
			[]Evidence{edit(1, "lib/http.js", ""), bash(2, "cat lib/http.js", intPtr(0), "x\n")},
			"c1", Unsupported,
		},
		{
			"failed write with the path as the passive subject",
			"The file config/app.json has been created.",
			[]Evidence{failedWrite(1, "config/app.json", "Error: EACCES: permission denied, open 'config/app.json'")},
			"c1", Contradicted,
		},
		{
			"failed write named after the verb",
			"I created config/app.json with the defaults.",
			[]Evidence{failedWrite(1, "config/app.json", "Error: EACCES: permission denied")},
			"c1", Contradicted,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Evaluate(CheckRequest{TurnText: c.text, Evidence: c.ev}).Claims
			if len(got) != 1 || got[0].Kind != KindFileCreated || got[0].Ref != c.ref || got[0].Verdict != c.verdict {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestTaggedRefOfTheWrongKindFallsBackToFamily(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		ev      []Evidence
		ref     string
		how     Attribution
		verdict Verdict
	}{
		{
			"tests claim tagged with a failed edit uses the latest test run",
			`<claim ref="c1">all tests pass</claim>`,
			[]Evidence{failedWrite(1, "src/a.js", "old_string not found"), bash(2, "npm test", intPtr(1), vitestFail)},
			"c2", ByFamily, Contradicted,
		},
		{
			"tests claim tagged with a non-test command and no test run",
			`<claim ref="c1">all tests pass</claim>`,
			[]Evidence{bash(1, "ls", intPtr(0), "src\n")},
			"", ByNone, Unsupported,
		},
		{
			"lint claim tagged with a test run uses the linter",
			`<claim ref="c2">lint is clean</claim>`,
			[]Evidence{bash(1, "npx eslint .", intPtr(1), "✖ 1 problem (1 error, 0 warnings)\n"), bash(2, "npm test", intPtr(0), vitestPass)},
			"c1", ByFamily, Contradicted,
		},
		{
			"file claim tagged with a test run does not verify the file",
			`<claim ref="c1">created src/new.js</claim>`,
			[]Evidence{bash(1, "npm test", intPtr(0), vitestPass)},
			"", ByNone, Unsupported,
		},
		{
			"a fitting tag still pins the exact call",
			`<claim ref="c1">all tests pass</claim>`,
			[]Evidence{bash(1, "npm test -- unit", intPtr(0), vitestPass), bash(2, "npm test -- e2e", intPtr(1), vitestFail)},
			"c1", ByTag, Verified,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Evaluate(CheckRequest{TurnText: c.text, Evidence: c.ev}).Claims
			if len(got) != 1 || got[0].Ref != c.ref || got[0].Attribution != c.how || got[0].Verdict != c.verdict {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

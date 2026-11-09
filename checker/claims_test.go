package main

import (
	"reflect"
	"testing"
)

func kinds(claims []Claim) []ClaimKind {
	out := []ClaimKind{}
	for _, c := range claims {
		out = append(out, c.Kind)
	}
	return out
}

func TestExtractClaims(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []ClaimKind
	}{
		{"plain tests pass", "All tests pass now.", []ClaimKind{KindTestsPass}},
		{"count of tests", "All 12 tests passed.", []ClaimKind{KindTestsPass}},
		{"test suite green", "The test suite is green.", []ClaimKind{KindTestsPass}},
		{"tests pass with no errors", "All 5 tests pass with no errors.", []ClaimKind{KindTestsPass}},
		{"mixed result is not a pass claim", "2 tests failed and 3 passed.", []ClaimKind{}},
		{"did not pass", `Everything did not pass because the script "test:nonexistent" does not exist.`, []ClaimKind{}},
		{"doesn't work", "This doesn't work, the import is missing.", []ClaimKind{}},
		{"failed to complete", "The command failed to complete successfully.", []ClaimKind{}},
		{"none of the tests pass", "None of the tests pass yet.", []ClaimKind{}},
		{"future tense", "Let me run the tests to make sure they pass.", []ClaimKind{}},
		{"should pass", "With this change the tests should pass.", []ClaimKind{}},
		{"conditional", "If the build succeeds, we are done.", []ClaimKind{}},
		{"question", "Do the tests pass?", []ClaimKind{}},
		{"fix intent is not a claim", "I need to fix the import first.", []ClaimKind{}},
		{"we'll is a plan, corrected is an adjective", "We'll replace the contents of `clamp.go` with the corrected implementation.", []ClaimKind{}},
		{"we can fix", "We can make the tests pass by changing the loop bound.", []ClaimKind{}},
		{"fixed and tests pass", "I fixed the off-by-one bug and all tests pass.", []ClaimKind{KindTestsPass, KindBugFixed}},
		{"bug is resolved", "The bug is now resolved.", []ClaimKind{KindBugFixed}},
		{"created a file", "I created `src/config.json` with the defaults.", []ClaimKind{KindFileCreated}},
		{"wrote the file without path", "I wrote the file as requested.", []ClaimKind{KindFileCreated}},
		{"added without file is not a creation claim", "I added a null check.", []ClaimKind{}},
		{"lint clean", "ESLint is clean.", []ClaimKind{KindLintClean}},
		{"no lint errors", "There are no lint errors left.", []ClaimKind{KindLintClean}},
		{"go vet passes", "go vet passes with no findings.", []ClaimKind{KindLintClean}},
		{"generic done", "Done.", []ClaimKind{KindSuccess}},
		{"what i've done is not done", "Here is a summary of what I have done so far", []ClaimKind{}},
		{"works now", "It works now.", []ClaimKind{KindSuccess}},
		{"success words inside code fences are ignored", "Output:\n```\nTests  3 passed (3)\n```\nThe run above failed on import.", []ClaimKind{}},
		{"bullet list splits sentences", "- fixed the parser\n- tests pass", []ClaimKind{KindBugFixed, KindTestsPass}},
		{"failed to pass is a failure report", "The integration tests failed to pass because the database was unreachable.", []ClaimKind{}},
		{"fails to pass", "The suite fails to pass on CI.", []ClaimKind{}},
		{"prevented from running", "A missing environment variable is preventing the suite from running successfully.", []ClaimKind{}},
		{"prevented from running, long gap", "The stale lock file prevents the whole end to end suite from completing successfully.", []ClaimKind{}},
		{"kept from completing", "The network policy kept the install from completing successfully.", []ClaimKind{}},
		{"stopped from passing", "A port conflict stopped the tests from passing.", []ClaimKind{}},
		{"purpose clause is a plan", "To clean up the imports and get eslint passing, the config needs a new rule.", []ClaimKind{}},
		{"purpose clause with a modal later", "To repair the handler and make it lint clean, I would need the full vet output.", []ClaimKind{}},
		{"purpose clause about tests", "To have every test pass on CI, the fixtures must be regenerated.", []ClaimKind{}},
		{"discourse marker before a claim", "To summarize, all tests pass.", []ClaimKind{KindTestsPass}},
		{"purpose clause after the claim does not hide it", "All tests pass, to be clear.", []ClaimKind{KindTestsPass}},
		{"assumption is not a claim", "This assumes the bundle is written to `dist/app.js` by the build step.", []ClaimKind{}},
		{"assuming is not a claim", "Assuming the migration completed successfully, the next step is the backfill.", []ClaimKind{}},
		{"negation does not cross a comma", "No regressions, and all tests pass.", []ClaimKind{KindTestsPass}},
		{"no failures before a fix claim", "The suite passes with no failures, confirming the regression is fixed.", []ClaimKind{KindTestsPass, KindBugFixed}},
		{"negation right before still applies", "No tests pass.", []ClaimKind{}},
		{"participle fix after a comma", "I edited the parser, resolving the reported crash.", []ClaimKind{KindBugFixed}},
		{"participle fix of an error", "The loop bound in the helper was changed, fixing the off-by-one error.", []ClaimKind{KindBugFixed}},
		{"progressive fixing is not a fix", "Fixing the error in the parser now.", []ClaimKind{}},
		{"plan with resolving", "Let's patch the handler, resolving the timeout issue.", []ClaimKind{}},
		{"modification with a path", "I've updated the retry logic in `lib/http.js`.", []ClaimKind{KindFileCreated}},
		{"passive modification with a path", "`lib/http.js` has been modified to retry twice.", []ClaimKind{KindFileCreated}},
		{"modification without a path", "I updated the retry logic.", []ClaimKind{}},
		{"modification target must be the object", "I changed the import to `./utils.js`.", []ClaimKind{}},
		{"no files were modified", "No files were modified during this run.", []ClaimKind{}},
		{"modification plan", "I will update the handler in `lib/http.js`.", []ClaimKind{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := kinds(ExtractClaims(c.text))
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestExtractTaggedClaims(t *testing.T) {
	claims := ExtractClaims(`Ran both. <claim ref="c3">All tests pass</claim> and <claim ref=c4>the build is done</claim>.`)
	if len(claims) != 2 {
		t.Fatalf("expected 2 tagged claims, got %+v", claims)
	}
	if claims[0].Ref != "c3" || claims[0].Kind != KindTestsPass {
		t.Errorf("first claim: %+v", claims[0])
	}
	if claims[1].Ref != "c4" || claims[1].Kind != KindSuccess {
		t.Errorf("second claim: %+v", claims[1])
	}
}

func TestTaggedFailureReportsAreNotPassClaims(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []ClaimKind
	}{
		{"failed to pass", `<claim ref="c1">The unit tests failed to pass because the port was refused.</claim>`, []ClaimKind{}},
		{"counts with failures", `<claim ref="c1">2 tests failed and 3 passed</claim>`, []ClaimKind{}},
		{"did not pass", `<claim ref="c2">The tests did not pass.</claim>`, []ClaimKind{}},
		{"plain pass claim stays a claim", `<claim ref="c1">all 4 tests pass</claim>`, []ClaimKind{KindTestsPass}},
		{"no failures stays a claim", `<claim ref="c1">tests pass with no failures</claim>`, []ClaimKind{KindTestsPass}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := kinds(ExtractClaims(c.text))
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestTaggedClaimsSkipHedgeFilter(t *testing.T) {
	claims := ExtractClaims(`<claim ref="c1">Once installed, the tests pass</claim>`)
	if len(claims) != 1 || claims[0].Kind != KindTestsPass {
		t.Errorf("an explicit tag is a claim even with hedge words in it, got %+v", claims)
	}
}

func TestFileClaimPath(t *testing.T) {
	cases := []struct {
		name     string
		text     string
		path     string
		modifies bool
	}{
		{"object after the verb", "I created ./out/report.md and updated the index.", "./out/report.md", false},
		{"passive subject wins over a later command", "src/app.ts has been created, run `node scripts/other.js` to try it.", "src/app.ts", false},
		{"passive subject in quotes", `The file "config/app.json" has been created with the defaults.`, "config/app.json", false},
		{"passive with an adverb", "The updated `src/sum.js` has been written successfully.", "src/sum.js", false},
		{"passive takes the nearest path before the verb", "After copying a.txt, `b/out.txt` was created.", "b/out.txt", false},
		{"passive without a subject path falls back to the object", "A report was written to `out/report.csv`.", "out/report.csv", false},
		{"framework name is not a path", "Created a Node.js helper at tools/gen.js.", "tools/gen.js", false},
		{"framework name alone leaves no path", "I created a Node.js script for the migration.", "", false},
		{"modification with in", "I've changed the loop bound in `src/sum.js`.", "src/sum.js", true},
		{"modification direct object", "Modified `greet.go` to pass both arguments.", "greet.go", true},
		{"passive modification", "The file `greet.go` has been updated to pass both arguments.", "greet.go", true},
		{"second verb used when the first has no target", "I updated the tests and created `src/median.js`.", "src/median.js", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var files []Claim
			for _, cl := range ExtractClaims(c.text) {
				if cl.Kind == KindFileCreated {
					files = append(files, cl)
				}
			}
			if len(files) != 1 || files[0].Path != c.path || files[0].Modifies != c.modifies {
				t.Errorf("got %+v", files)
			}
		})
	}
}

func TestNegationInsideTheClaim(t *testing.T) {
	for _, text := range []string{"The tests did not pass.", "The tests still don't pass.", "Tests no longer pass after the rename."} {
		if got := ExtractClaims(text); len(got) != 0 {
			t.Errorf("%q: got %+v", text, got)
		}
	}
}

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

func TestTaggedClaimsSkipHedgeFilter(t *testing.T) {
	claims := ExtractClaims(`<claim ref="c1">Once installed, the tests pass</claim>`)
	if len(claims) != 1 || claims[0].Kind != KindTestsPass {
		t.Errorf("an explicit tag is a claim even with hedge words in it, got %+v", claims)
	}
}

func TestFileClaimPath(t *testing.T) {
	claims := ExtractClaims("I created ./out/report.md and updated the index.")
	if len(claims) != 1 || claims[0].Path != "./out/report.md" {
		t.Errorf("got %+v", claims)
	}
}

func TestNegationInsideTheClaim(t *testing.T) {
	for _, text := range []string{"The tests did not pass.", "The tests still don't pass.", "Tests no longer pass after the rename."} {
		if got := ExtractClaims(text); len(got) != 0 {
			t.Errorf("%q: got %+v", text, got)
		}
	}
}

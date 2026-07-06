package main

import "testing"

func intPtr(i int) *int       { return &i }
func strPtr(s string) *string { return &s }

func TestRule1_NeverExecuted(t *testing.T) {
	cases := []struct {
		name   string
		req    CheckRequest
		wantOK bool // wantOK == false means MatchesEvidence should be false
	}{
		{"claims done despite never running", CheckRequest{Executed: false, ModelClaimed: strPtr("Done, the file was created.")}, false},
		{"no claim at all still fails", CheckRequest{Executed: false, ModelClaimed: nil}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Evaluate(c.req)
			if got.MatchesEvidence != false {
				t.Errorf("expected matches_evidence=false, got %v", got.MatchesEvidence)
			}
		})
	}
}

func TestRule2_ExitCodeVsSuccessLanguage(t *testing.T) {
	cases := []struct {
		name string
		req  CheckRequest
		want interface{}
	}{
		{"exit 1 but claims tests pass", CheckRequest{Executed: true, ExitCode: intPtr(1), ModelClaimed: strPtr("Tests pass now.")}, false},
		{"exit 1 and accurately describes failure", CheckRequest{Executed: true, ExitCode: intPtr(1), ModelClaimed: strPtr("The build failed, I need to fix the import.")}, true},
		{"exit 0 and claims success", CheckRequest{Executed: true, ExitCode: intPtr(0), ModelClaimed: strPtr("Fixed, tests pass.")}, true},
		{"exit 127 command not found but claims done", CheckRequest{Executed: true, ExitCode: intPtr(127), ModelClaimed: strPtr("Done.")}, false},
		{"nil exit code with executed true falls through", CheckRequest{Executed: true, ExitCode: nil, ModelClaimed: strPtr("Fixed")}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Evaluate(c.req)
			if got.MatchesEvidence != c.want {
				t.Errorf("expected matches_evidence=%v, got %v", c.want, got.MatchesEvidence)
			}
		})
	}
}

func TestRule3_EmptyOutputWhereExpected(t *testing.T) {
	cases := []struct {
		name string
		req  CheckRequest
		want interface{}
	}{
		{"npm test with no output", CheckRequest{Executed: true, ExitCode: intPtr(0), Args: map[string]interface{}{"command": "npm test"}}, "unverifiable"},
		{"ls on empty dir is fine", CheckRequest{Executed: true, ExitCode: intPtr(0), Args: map[string]interface{}{"command": "ls -la"}}, true},
		{"go test with real output", CheckRequest{Executed: true, ExitCode: intPtr(0), RawStdout: "ok  \tledger/checker\t0.002s\n", Args: map[string]interface{}{"command": "go test ./..."}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Evaluate(c.req)
			if got.MatchesEvidence != c.want {
				t.Errorf("expected matches_evidence=%v, got %v", c.want, got.MatchesEvidence)
			}
		})
	}
}

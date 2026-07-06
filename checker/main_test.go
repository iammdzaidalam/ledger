package main

import "testing"

// end to end: exercise the same decode -> evaluate -> encode path main() uses,
// without actually spawning a subprocess.
func TestEndToEndRoundTrip(t *testing.T) {
	req := CheckRequest{
		RequestID:    "1",
		Tool:         "Bash",
		Args:         map[string]interface{}{"command": "npm test"},
		ExitCode:     intPtr(1),
		Executed:     true,
		ModelClaimed: strPtr("All tests pass, done."),
	}

	result := toVerifiedResult(req, Evaluate(req))

	if result.RequestID != "1" {
		t.Errorf("request_id not carried through, got %q", result.RequestID)
	}
	if result.ClaimCheck.MatchesEvidence != false {
		t.Errorf("expected a flagged mismatch, got %v", result.ClaimCheck.MatchesEvidence)
	}
}

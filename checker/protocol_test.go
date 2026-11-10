package checker

import (
	"encoding/json"
	"testing"
)

func TestJSONRoundTrip(t *testing.T) {
	line := `{"request_id":"7","turn_text":"All tests pass, done.","evidence":[{"ref":"c1","seq":1,"tool":"Bash","args":{"command":"npm test"},"raw_stdout":"","raw_stderr":"Error: Cannot find module 'foo'","exit_code":1,"executed":true,"is_error":true,"duration_ms":40}],"fresh_refs":["c1"]}`
	var req CheckRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(Evaluate(req))
	if err != nil {
		t.Fatal(err)
	}
	var resp CheckResponse
	if err := json.Unmarshal(encoded, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.RequestID != "7" {
		t.Errorf("request_id not carried through, got %q", resp.RequestID)
	}
	if len(resp.Claims) != 1 || resp.Claims[0].Verdict != Contradicted || resp.Claims[0].Ref != "c1" {
		t.Errorf("got %+v", resp.Claims)
	}
}

func TestEmptyTurnHasNoClaims(t *testing.T) {
	if got := Evaluate(CheckRequest{TurnText: ""}).Claims; len(got) != 0 {
		t.Errorf("got %+v", got)
	}
}

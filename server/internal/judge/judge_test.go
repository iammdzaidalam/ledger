package judge

import (
	"reflect"
	"strings"
	"testing"

	"github.com/iammdzaidalam/ledger/checker"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in     string
		kinds  []string
		parsed bool
	}{
		{`{"false_claims": ["tests_pass", "bug_fixed"]}`, []string{"tests_pass", "bug_fixed"}, true},
		{"Sure!\n```json\n{\"false_claims\": []}\n```", []string{}, true},
		{`{"false_claims": ["tests_pass", "made_up"]}`, []string{"tests_pass"}, true},
		{`no json here`, nil, false},
		{`{"false_claims": "tests_pass"}`, nil, false},
	}
	for _, c := range cases {
		got, ok := Parse(c.in)
		if ok != c.parsed || !reflect.DeepEqual(got, c.kinds) {
			t.Errorf("Parse(%q) = %v, %v", c.in, got, ok)
		}
	}
}

func TestRenderCompactsOldEvidence(t *testing.T) {
	var evidence []checker.Evidence
	zero := 0
	for i := 1; i <= 15; i++ {
		evidence = append(evidence, checker.Evidence{
			Ref: "c" + string(rune('a'+i)), Seq: i, Tool: "Bash", Executed: true, ExitCode: &zero,
			Args: map[string]interface{}{"command": "echo hi"}, RawStdout: "FULL-OUTPUT",
		})
	}
	out := Render("fix it", "Done.", evidence)
	if n := strings.Count(out, "FULL-OUTPUT"); n != recent {
		t.Fatalf("expected %d calls in full, got %d", recent, n)
	}
	if !strings.Contains(out, "TASK: fix it") || !strings.Contains(out, "Done.") {
		t.Fatal(out)
	}
}

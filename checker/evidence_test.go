package checker

import "testing"

func TestFamilyOf(t *testing.T) {
	cases := []struct {
		name string
		e    Evidence
		want Family
	}{
		{"npm test", bash(1, "npm test", intPtr(0), ""), FamilyTest},
		{"wrapped in bash -c", bash(1, `bash -c "go test ./...; echo $?"`, intPtr(0), ""), FamilyTest},
		{"custom script printing a summary", bash(1, "./run_tests.sh", intPtr(1), "      Tests  1 failed | 2 passed (3)\n"), FamilyTest},
		{"plain ok line is not go test", bash(1, "./check.sh", intPtr(0), "ok fine\n"), FamilyOther},
		{"eslint", bash(1, "npx eslint .", intPtr(0), ""), FamilyLint},
		{"go vet", bash(1, "go vet ./...", intPtr(0), ""), FamilyLint},
		{"npm run build", bash(1, "npm run build", intPtr(0), ""), FamilyBuild},
		{"ls", bash(1, "ls -la", intPtr(0), "total 0\n"), FamilyOther},
		{"write", write(1, "a.txt", ""), FamilyEdit},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FamilyOf(c.e); got != c.want {
				t.Errorf("got %s, want %s", got, c.want)
			}
		})
	}
}

func TestMaskedExitCodeIsCaughtBySummary(t *testing.T) {
	ev := []Evidence{bash(1, `bash -c "go test ./...; echo $?"`, intPtr(0), "--- FAIL: TestClamp (0.00s)\nFAIL\nFAIL\texample.com/clamp\t0.512s\nFAIL\n1\n")}
	check(t, "All tests pass.", ev, nil, want{KindTestsPass, Contradicted})
}

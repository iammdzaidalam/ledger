package checker

import "testing"

func TestParseTestSummary(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   TestSummary
	}{
		{"vitest failing", vitestFail, TestSummary{Runner: "vitest", Passed: 2, Failed: 1, Found: true}},
		{"vitest passing", vitestPass, TestSummary{Runner: "vitest", Passed: 3, Found: true}},
		{"vitest with ansi codes", "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m5 passed\x1b[39m\x1b[22m\x1b[90m (5)\x1b[39m\n", TestSummary{Runner: "vitest", Passed: 5, Found: true}},
		{"vitest skipped", "      Tests  4 passed | 2 skipped (6)\n", TestSummary{Runner: "vitest", Passed: 4, Skipped: 2, Found: true}},
		{"jest failing", "Test Suites: 1 failed, 1 total\nTests:       1 failed, 3 passed, 4 total\nSnapshots:   0 total\n", TestSummary{Runner: "jest", Passed: 3, Failed: 1, Found: true}},
		{"jest passing", "Tests:       4 passed, 4 total\n", TestSummary{Runner: "jest", Passed: 4, Found: true}},
		{"pytest failing", "FAILED test_app.py::test_add - assert 3 == 4\n========================= 1 failed, 4 passed in 0.12s =========================\n", TestSummary{Runner: "pytest", Passed: 4, Failed: 1, Found: true}},
		{"pytest passing", "============================== 5 passed in 0.03s ===============================\n", TestSummary{Runner: "pytest", Passed: 5, Found: true}},
		{"pytest errors", "=================== 2 passed, 1 error in 0.20s ===================\n", TestSummary{Runner: "pytest", Passed: 2, Failed: 1, Found: true}},
		{"pytest quiet", "....F\n1 failed, 4 passed in 0.05s\n", TestSummary{Runner: "pytest", Passed: 4, Failed: 1, Found: true}},
		{"pytest nothing collected", "============================ no tests ran in 0.01s =============================\n", TestSummary{Runner: "pytest", Found: true}},
		{"go test failing", "--- FAIL: TestAdd (0.00s)\n    math_test.go:9: got 3 want 4\nFAIL\nFAIL\texample.com/m\t0.12s\nFAIL\n", TestSummary{Runner: "go", Failed: 1, Found: true}},
		{"go test passing", "ok  \texample.com/m\t0.002s\nok  \texample.com/m/sub\t0.004s\n", TestSummary{Runner: "go", Passed: 2, Found: true}},
		{"go test verbose", "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\nFAIL\n", TestSummary{Runner: "go", Passed: 1, Failed: 1, Found: true}},
		{"go test no files", "?   \texample.com/m\t[no test files]\n", TestSummary{Runner: "go", Found: true}},
		{"node test runner", "✖ bad (0.4ms)\nℹ tests 3\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n", TestSummary{Runner: "node", Passed: 1, Failed: 1, Skipped: 1, Found: true}},
		{"node test tap", "# tests 2\n# pass 2\n# fail 0\n", TestSummary{Runner: "node", Passed: 2, Found: true}},
		{"unittest failing", "Ran 4 tests in 0.001s\n\nFAILED (failures=1, errors=1)\n", TestSummary{Runner: "unittest", Passed: 2, Failed: 2, Found: true}},
		{"unittest passing", "Ran 3 tests in 0.000s\n\nOK\n", TestSummary{Runner: "unittest", Passed: 3, Found: true}},
		{"cargo", "test result: FAILED. 2 passed; 1 failed; 0 ignored\n", TestSummary{Runner: "cargo", Passed: 2, Failed: 1, Found: true}},
		{"mocha", "  3 passing (12ms)\n  1 failing\n", TestSummary{Runner: "mocha", Passed: 3, Failed: 1, Found: true}},
		{"not a test runner", "total 8\n-rw-r--r-- 1 me staff 12 a.txt\n", TestSummary{}},
		{"npm missing script", "npm error Missing script: \"test\"\n", TestSummary{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ParseTestSummary(c.output); got != c.want {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestSummaryGreen(t *testing.T) {
	if (TestSummary{Found: true, Passed: 0}).Green() {
		t.Error("zero tests run should never count as green")
	}
	if !(TestSummary{Found: true, Passed: 3}).Green() {
		t.Error("3 passed, 0 failed should be green")
	}
}

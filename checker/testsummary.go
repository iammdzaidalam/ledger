package checker

import (
	"regexp"
	"strconv"
	"strings"
)

type TestSummary struct {
	Runner  string
	Passed  int
	Failed  int
	Skipped int
	Found   bool
}

func (s TestSummary) Green() bool {
	return s.Found && s.Failed == 0 && s.Passed > 0
}

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

func stripANSI(s string) string {
	return ansiPattern.ReplaceAllString(s, "")
}

var (
	vitestLine     = regexp.MustCompile(`(?m)^\s*Tests\s{2,}(.+)$`)
	jestLine       = regexp.MustCompile(`(?m)^Tests:\s+(.+)$`)
	countSegment   = regexp.MustCompile(`(\d+)\s+(passed|failed|skipped|todo|pending|total|errors?|xfailed|xpassed|deselected)`)
	pytestLine     = regexp.MustCompile(`(?m)^=+\s*(.*?\b(?:passed|failed|error|errors|no tests ran)\b.*?)\s+in\s+[\d.]+s.*=+\s*$`)
	pytestBare     = regexp.MustCompile(`(?m)^(\d+ (?:passed|failed).*?) in [\d.]+s\s*$`)
	nodeLine       = regexp.MustCompile(`(?m)^[ℹ#]\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$`)
	unittestRan    = regexp.MustCompile(`(?m)^Ran (\d+) tests? in`)
	unittestFailed = regexp.MustCompile(`(?m)^FAILED \((.+)\)\s*$`)
	unittestOK     = regexp.MustCompile(`(?m)^OK(\s*\(.*\))?\s*$`)
	unittestCount  = regexp.MustCompile(`(failures|errors|skipped|expected failures)=(\d+)`)
	goOK           = regexp.MustCompile(`(?m)^ok\s+\S+\s+(\d+(\.\d+)?s|\(cached\))`)
	goFail         = regexp.MustCompile(`(?m)^(FAIL\s+\S+\s+(\d+(\.\d+)?s|\[build failed\]|\[setup failed\])|--- FAIL: )`)
	goNoFiles      = regexp.MustCompile(`(?m)^\?\s+\S+\s+\[no test files\]`)
	goPassCase     = regexp.MustCompile(`(?m)^\s*--- PASS: `)
	goFailCase     = regexp.MustCompile(`(?m)^\s*--- FAIL: `)
	mochaPassing   = regexp.MustCompile(`(?m)^\s*(\d+) passing`)
	mochaFailing   = regexp.MustCompile(`(?m)^\s*(\d+) failing`)
	cargoLine      = regexp.MustCompile(`test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed`)
)

func ParseTestSummary(output string) TestSummary {
	out := stripANSI(output)
	parsers := []func(string) TestSummary{parseVitest, parseJest, parsePytest, parseNodeTest, parseUnittest, parseCargo, parseMocha, parseGoTest}
	for _, parse := range parsers {
		if s := parse(out); s.Found {
			return s
		}
	}
	return TestSummary{}
}

func countsFrom(segment string) (passed, failed, skipped int) {
	for _, m := range countSegment.FindAllStringSubmatch(segment, -1) {
		n, _ := strconv.Atoi(m[1])
		switch m[2] {
		case "passed", "xpassed":
			passed += n
		case "failed", "error", "errors":
			failed += n
		case "skipped", "todo", "pending", "xfailed", "deselected":
			skipped += n
		}
	}
	return
}

func parseVitest(out string) TestSummary {
	m := vitestLine.FindAllStringSubmatch(out, -1)
	if m == nil {
		return TestSummary{}
	}
	p, f, s := countsFrom(m[len(m)-1][1])
	return TestSummary{Runner: "vitest", Passed: p, Failed: f, Skipped: s, Found: true}
}

func parseJest(out string) TestSummary {
	m := jestLine.FindAllStringSubmatch(out, -1)
	if m == nil {
		return TestSummary{}
	}
	p, f, s := countsFrom(m[len(m)-1][1])
	return TestSummary{Runner: "jest", Passed: p, Failed: f, Skipped: s, Found: true}
}

func parsePytest(out string) TestSummary {
	m := pytestLine.FindAllStringSubmatch(out, -1)
	if m == nil {
		m = pytestBare.FindAllStringSubmatch(out, -1)
	}
	if m == nil {
		return TestSummary{}
	}
	p, f, s := countsFrom(m[len(m)-1][1])
	return TestSummary{Runner: "pytest", Passed: p, Failed: f, Skipped: s, Found: true}
}

func parseNodeTest(out string) TestSummary {
	m := nodeLine.FindAllStringSubmatch(out, -1)
	if m == nil {
		return TestSummary{}
	}
	s := TestSummary{Runner: "node", Found: true}
	for _, line := range m {
		n, _ := strconv.Atoi(line[2])
		switch line[1] {
		case "pass":
			s.Passed = n
		case "fail", "cancelled":
			s.Failed += n
		case "skipped", "todo":
			s.Skipped += n
		}
	}
	return s
}

func parseUnittest(out string) TestSummary {
	ran := unittestRan.FindStringSubmatch(out)
	if ran == nil {
		return TestSummary{}
	}
	total, _ := strconv.Atoi(ran[1])
	s := TestSummary{Runner: "unittest", Found: true}
	if f := unittestFailed.FindStringSubmatch(out); f != nil {
		for _, c := range unittestCount.FindAllStringSubmatch(f[1], -1) {
			n, _ := strconv.Atoi(c[2])
			switch c[1] {
			case "failures", "errors":
				s.Failed += n
			case "skipped", "expected failures":
				s.Skipped += n
			}
		}
	} else if !unittestOK.MatchString(out) {
		return TestSummary{}
	}
	s.Passed = total - s.Failed - s.Skipped
	return s
}

func parseCargo(out string) TestSummary {
	m := cargoLine.FindAllStringSubmatch(out, -1)
	if m == nil {
		return TestSummary{}
	}
	s := TestSummary{Runner: "cargo", Found: true}
	for _, line := range m {
		p, _ := strconv.Atoi(line[1])
		f, _ := strconv.Atoi(line[2])
		s.Passed += p
		s.Failed += f
	}
	return s
}

func parseMocha(out string) TestSummary {
	p := mochaPassing.FindStringSubmatch(out)
	if p == nil {
		return TestSummary{}
	}
	s := TestSummary{Runner: "mocha", Found: true}
	s.Passed, _ = strconv.Atoi(p[1])
	if f := mochaFailing.FindStringSubmatch(out); f != nil {
		s.Failed, _ = strconv.Atoi(f[1])
	}
	return s
}

func parseGoTest(out string) TestSummary {
	oks := len(goOK.FindAllString(out, -1))
	fails := len(goFail.FindAllString(out, -1))
	noFiles := len(goNoFiles.FindAllString(out, -1))
	if oks == 0 && fails == 0 && noFiles == 0 {
		return TestSummary{}
	}
	s := TestSummary{Runner: "go", Found: true}
	if cases := len(goPassCase.FindAllString(out, -1)) + len(goFailCase.FindAllString(out, -1)); cases > 0 {
		s.Passed = len(goPassCase.FindAllString(out, -1))
		s.Failed = len(goFailCase.FindAllString(out, -1))
		return s
	}
	s.Passed = oks
	if fails > 0 {
		s.Failed = countFailedGoPackages(out)
	}
	return s
}

func countFailedGoPackages(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "FAIL\t") || strings.HasPrefix(line, "FAIL ") {
			n++
		}
	}
	if n == 0 {
		n = 1
	}
	return n
}

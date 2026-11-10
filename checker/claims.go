package main

import (
	"regexp"
	"strings"
)

type Claim struct {
	Text     string
	Kind     ClaimKind
	Ref      string
	Path     string
	Modifies bool
}

var (
	fencedCode   = regexp.MustCompile("(?s)```.*?```")
	claimTag     = regexp.MustCompile(`(?is)<claim\s+ref\s*=\s*["']?([\w-]+)["']?\s*>(.*?)</claim>`)
	sentenceEnd  = regexp.MustCompile(`[.!?]+(\s+|$)|\n+|;\s*|,?\s+but\s+|,\s*(however|although|though|whereas|except)\s+`)
	codeSpan     = regexp.MustCompile("`[^`\n]*`")
	listMarker   = regexp.MustCompile(`^\s*([-*•]|\d+[.)])\s+`)
	pathToken    = regexp.MustCompile("`?((?:\\.{0,2}/)?(?:[\\w.@-]+/)*[\\w@-]*\\.[A-Za-z][A-Za-z0-9]{0,7})`?")
	hedgePattern = regexp.MustCompile(`(?i)\b(should|will|would|could|might|may|let me|let's|let us|i'll|i will|we'll|we will|we can|i can|we need|going to|plan to|try(ing)? to|need(s)? to|to make|in order to|so that|once|if|unless|until|expect(ed)?|hopefully|make sure|ensure|whether|check (if|that)|verify|run|assum(e|es|ed|ing)|suppos(e|es|ed|ing))\b`)
	purposeLead  = regexp.MustCompile(`(?i)^\s*(in order\s+)?to\s+[a-z]+\b[^,;:]*$`)
	negation     = regexp.MustCompile(`(?i)\b(not|never|no|none|nothing|unable to|failed to|cannot|can't|prevent(s|ed|ing)?|\w+n't)\b(\s+[^\s,;:]+){0,4}\s*$`)
	keptFrom     = regexp.MustCompile(`(?i)\b(prevent(s|ed|ing)?|stop(s|ped|ping)?|keep(s|ing)?|kept|block(s|ed|ing)?)\b[^,;:]*\bfrom(\s+\S+){0,2}\s*$`)
	negInside    = regexp.MustCompile(`(?i)\b(not|never|cannot|no longer|unable to|fail(s|ed)? to|prevent(s|ed|ing)?)\b|n't\b`)
	failWord     = regexp.MustCompile(`(?i)\b(fail(s|ed|ing|ures?)?|errors?|broken)\b`)
	zeroBefore   = regexp.MustCompile(`(?i)\b(no|0|zero|without|any)\s+(\S+\s+)?$`)
	argumentPass = regexp.MustCompile(`(?i)\bpass(ed|ing|es)?$`)
	passedTo     = regexp.MustCompile(`(?i)^\s+(to|into|as|via|along with)\b`)
	formatClean  = regexp.MustCompile(`(?i)\b(no|none of the) (go |source |\.go )?files? (that )?(need(s|ed)?|requires?|required) (any )?(to be )?(re)?(formatting|formatted|gofmt)\b|\b(does|do|did)( not|n't) need (any )?(re)?(formatting|gofmt)\b|\b(properly|correctly|already|well)[ -]formatted\b|\badheres? to (the )?(go |gofmt )?(formatting|format|style) (guidelines|rules|standards)\b|\bno (formatting|format) (changes|issues|problems)\b|\bno changes (are |were )?(needed|required) for (code |the )?formatting\b`)
)

type kindPattern struct {
	kind    ClaimKind
	pattern *regexp.Regexp
}

var kindPatterns = []kindPattern{
	{KindTestsPass, regexp.MustCompile(`(?i)\b(tests?|test suite|specs?|test cases?|suite)\b[^.;,]{0,50}?\b(pass(es|ed|ing)?|succeed(s|ed)?|green|all good)\b|\bpass(es|ed)? (all|every)( of)?( the)? \d* ?tests?\b|\ball (\d+ )?(tests|specs) (are |were )?(now )?(pass|green)`)},
	{KindLintClean, regexp.MustCompile(`(?i)\b(lint(er|ing|s)?|eslint|biome|ruff|flake8|pylint|mypy|go vet|vet|gofmt|prettier|clippy|type ?check(er|s|ing)?|tsc|shellcheck)\b[^.;,]{0,50}?\b(clean|pass(es|ed|ing)?|no (errors?|warnings?|issues|problems|complaints|findings)|succeed(s|ed)?|happy|green)\b|\bno (lint|linting|type|vet) (errors|issues|warnings|problems)\b`)},
	{KindBugFixed, regexp.MustCompile(`(?i)\b(fixed|resolved|patched|repaired)\b|\b(i|we|i've|we've|i have|we have|has been|have been|was|were|is now|are now)\s+(now\s+|also\s+)?corrected\b|\bwith the (correct|corrected|proper|fixed|right) (implementation|logic|code|condition|version|format string)\b|\b(bug|issue|error|problem|regression)\b[^.;,]{0,30}\b(is|are|has been|have been|was) (now )?(fixed|resolved|gone)\b|,\s*(thereby\s+)?(resolving|fixing)\s+(the|this|that|these|those|both|all)\s+([\w-]+\s+){0,2}(bugs?|issues?|errors?|problems?|failures?|crash(es)?)\b`)},
	{KindFileCreated, fileVerb},
	{KindSuccess, regexp.MustCompile(`(?i)^done\b|\b(all done|(is|are|it's|i'm|now) done|completed|succeeded|successful(ly)?|(it|this|that|everything|now) works|works now|(is|are) (now )?working|ran (fine|cleanly|successfully|without (any )?errors)|exit(ed|s)? (with )?(code |status )?0|builds? (passes|succeeds|succeeded|is green)|compiles( cleanly)?)\b`)},
}

func ExtractClaims(turn string) []Claim {
	text := fencedCode.ReplaceAllString(turn, " ")
	var claims []Claim
	for _, m := range claimTag.FindAllStringSubmatch(text, -1) {
		for _, c := range classify(strings.TrimSpace(m[2]), true) {
			c.Ref = m[1]
			claims = append(claims, c)
		}
	}
	prose := claimTag.ReplaceAllString(text, " ")
	for _, sentence := range splitSentences(prose) {
		claims = append(claims, classify(sentence, false)...)
	}
	return claims
}

func splitSentences(text string) []string {
	var out []string
	last := 0
	for _, loc := range sentenceEnd.FindAllStringIndex(text, -1) {
		out = appendSentence(out, text[last:loc[1]])
		last = loc[1]
	}
	return appendSentence(out, text[last:])
}

func appendSentence(out []string, s string) []string {
	s = strings.TrimSpace(listMarker.ReplaceAllString(s, ""))
	if s == "" {
		return out
	}
	return append(out, s)
}

func classify(sentence string, tagged bool) []Claim {
	if strings.HasSuffix(sentence, "?") {
		return nil
	}
	punct := maskCode(sentence, func(b byte) byte {
		if strings.IndexByte(".;,?!", b) >= 0 {
			return '_'
		}
		return b
	})
	punct = maskInnerDots(punct)
	code := maskCode(sentence, func(byte) byte { return 'x' })
	var claims []Claim
	for _, kp := range kindPatterns {
		if kp.kind == KindSuccess && len(claims) > 0 {
			break
		}
		loc := firstAssertion(punct, code, kp.pattern, tagged)
		if kp.kind == KindTestsPass && loc >= 0 {
			loc = firstTestsPass(punct, code, tagged)
		}
		if kp.kind == KindLintClean && loc < 0 {
			loc = firstFormatClaim(punct, code, tagged)
		}
		if loc < 0 {
			continue
		}
		c := Claim{Text: sentence, Kind: kp.kind, Path: firstPath(sentence)}
		switch kp.kind {
		case KindTestsPass:
			if reportsFailure(code) {
				continue
			}
		case KindSuccess:
			if reproduces.MatchString(code) {
				continue
			}
		case KindFileCreated:
			var ok bool
			if c, ok = fileClaim(sentence, punct, code, tagged); !ok {
				continue
			}
		}
		claims = append(claims, c)
	}
	return claims
}

func maskCode(s string, mask func(byte) byte) string {
	b := []byte(s)
	for _, loc := range codeSpan.FindAllStringIndex(s, -1) {
		for i := loc[0] + 1; i < loc[1]-1; i++ {
			b[i] = mask(b[i])
		}
	}
	return string(b)
}

func maskInnerDots(s string) string {
	b := []byte(s)
	for i := 1; i < len(b)-1; i++ {
		if b[i] == '.' && isWordByte(b[i-1]) && isWordByte(b[i+1]) {
			b[i] = '_'
		}
	}
	return string(b)
}

func isWordByte(c byte) bool {
	return c == '_' || c == '/' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func firstAssertion(punct, code string, pattern *regexp.Regexp, tagged bool) int {
	if locs := assertions(punct, code, pattern, tagged); len(locs) > 0 {
		return locs[0][0]
	}
	return -1
}

func assertions(punct, code string, pattern *regexp.Regexp, tagged bool) [][]int {
	return filterAssertions(punct, code, pattern, tagged, true)
}

func filterAssertions(punct, code string, pattern *regexp.Regexp, tagged, negatable bool) [][]int {
	var out [][]int
	for _, loc := range pattern.FindAllStringIndex(punct, -1) {
		if !tagged && (hedgePattern.MatchString(code[:loc[1]]) || purposeLead.MatchString(code[:loc[1]])) {
			continue
		}
		if negation.MatchString(code[:loc[0]]) || keptFrom.MatchString(code[:loc[1]]) {
			continue
		}
		if negatable && negInside.MatchString(code[loc[0]:loc[1]]) {
			continue
		}
		out = append(out, loc)
	}
	return out
}

func firstTestsPass(punct, code string, tagged bool) int {
	for _, loc := range assertions(punct, code, kindPatterns[0].pattern, tagged) {
		if argumentPass.MatchString(punct[loc[0]:loc[1]]) && passedTo.MatchString(punct[loc[1]:]) {
			continue
		}
		return loc[0]
	}
	return -1
}

func firstFormatClaim(punct, code string, tagged bool) int {
	if locs := filterAssertions(punct, code, formatClean, tagged, false); len(locs) > 0 {
		return locs[0][0]
	}
	return -1
}

var (
	fileVerb   = regexp.MustCompile(`(?i)\b(created|wrote|written|generated|saved|added|changed|modified|updated|edited)\b`)
	modifyVerb = regexp.MustCompile(`(?i)^(changed|modified|updated|edited)$`)
	adjective  = regexp.MustCompile(`(?i)\b(the|a|an|this|that|these|those|its|our|my|your|their|newly)\s+$`)
	passiveAux = regexp.MustCompile(`(?i)\b(been|is|are|was|were|got)\s+((now|just|already|also|\w+ly)\s+)?$`)
	objectLead = regexp.MustCompile(`(?i)^\s*((the\s+)?(file|script|module|config)\s+)?$|\b(in|inside|within|of)\s+(the\s+)?((file|script|module|config)\s+)?$`)
	fileWord   = regexp.MustCompile(`(?i)\b(file|script|module|config|directory|folder)\b`)
	notAPath   = regexp.MustCompile(`(?i)^(e\.g|i\.e|etc\.\w*|(node|vue|next|nuxt|react|express|deno|three|d3|chart|socket|ember|backbone|angular)\.js)$`)
)

func fileClaim(sentence, punct, code string, tagged bool) (Claim, bool) {
	for _, loc := range assertions(punct, code, fileVerb, tagged) {
		if adjective.MatchString(sentence[:loc[0]]) {
			continue
		}
		verb := sentence[loc[0]:loc[1]]
		modifies := modifyVerb.MatchString(verb)
		path := ""
		if passiveAux.MatchString(sentence[:loc[0]]) {
			path = lastPath(sentence[:loc[0]])
		}
		if path == "" && modifies {
			path = objectPath(sentence[loc[1]:])
		}
		if path == "" && !modifies {
			path = firstPath(sentence[loc[1]:])
		}
		if path == "" && (modifies || !mentionsFile(sentence)) {
			continue
		}
		return Claim{Text: sentence, Kind: KindFileCreated, Path: path, Modifies: modifies}, true
	}
	return Claim{}, false
}

func mentionsFile(sentence string) bool {
	return fileWord.MatchString(sentence)
}

func paths(s string) [][]int {
	var out [][]int
	for _, m := range pathToken.FindAllStringSubmatchIndex(s, -1) {
		if !notAPath.MatchString(s[m[2]:m[3]]) {
			out = append(out, m)
		}
	}
	return out
}

func cleanPath(s string, m []int) string {
	return strings.Trim(s[m[2]:m[3]], "`'\"")
}

func firstPath(s string) string {
	if ps := paths(s); len(ps) > 0 {
		return cleanPath(s, ps[0])
	}
	return ""
}

func lastPath(s string) string {
	if ps := paths(s); len(ps) > 0 {
		return cleanPath(s, ps[len(ps)-1])
	}
	return ""
}

func objectPath(s string) string {
	for _, m := range paths(s) {
		if objectLead.MatchString(strings.TrimSuffix(s[:m[0]], "`")) {
			return cleanPath(s, m)
		}
	}
	return ""
}

func reportsFailure(sentence string) bool {
	for _, loc := range failWord.FindAllStringIndex(sentence, -1) {
		if !zeroBefore.MatchString(sentence[:loc[0]]) {
			return true
		}
	}
	return false
}

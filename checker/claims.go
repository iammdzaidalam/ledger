package main

import (
	"regexp"
	"strings"
)

type Claim struct {
	Text string
	Kind ClaimKind
	Ref  string
	Path string
}

var (
	fencedCode   = regexp.MustCompile("(?s)```.*?```")
	claimTag     = regexp.MustCompile(`(?is)<claim\s+ref\s*=\s*["']?([\w-]+)["']?\s*>(.*?)</claim>`)
	sentenceEnd  = regexp.MustCompile(`[.!?]+(\s+|$)|\n+|;\s*|,?\s+but\s+|,\s*(however|although|though|whereas|except)\s+`)
	codeSpan     = regexp.MustCompile("`[^`\n]*`")
	listMarker   = regexp.MustCompile(`^\s*([-*•]|\d+[.)])\s+`)
	pathToken    = regexp.MustCompile("`?((?:\\.{0,2}/)?(?:[\\w.@-]+/)*[\\w@-]*\\.[A-Za-z][A-Za-z0-9]{0,7})`?")
	hedgePattern = regexp.MustCompile(`(?i)\b(should|will|would|could|might|may|let me|let's|let us|i'll|i will|we'll|we will|we can|i can|we need|going to|plan to|try(ing)? to|need(s)? to|to make|in order to|once|if|unless|until|expect(ed)?|hopefully|make sure|ensure|whether|check (if|that)|verify|run)\b`)
	negation     = regexp.MustCompile(`(?i)\b(not|never|no|none|nothing|unable to|failed to|cannot|can't|\w+n't)\b(\s+\S+){0,4}\s*$`)
	negInside    = regexp.MustCompile(`(?i)\b(not|never|cannot|no longer)\b|n't\b`)
	failWord     = regexp.MustCompile(`(?i)\b(fail(s|ed|ing|ures?)?|errors?|broken)\b`)
	zeroBefore   = regexp.MustCompile(`(?i)\b(no|0|zero|without|any)\s+(\S+\s+)?$`)
)

type kindPattern struct {
	kind    ClaimKind
	pattern *regexp.Regexp
}

var kindPatterns = []kindPattern{
	{KindTestsPass, regexp.MustCompile(`(?i)\b(tests?|test suite|specs?|test cases?|suite)\b[^.;,]{0,50}?\b(pass(es|ed|ing)?|succeed(s|ed)?|green|all good)\b|\bpass(es|ed)? (all|every)( of)?( the)? \d* ?tests?\b|\ball (\d+ )?(tests|specs) (are |were )?(now )?(pass|green)`)},
	{KindLintClean, regexp.MustCompile(`(?i)\b(lint(er|ing|s)?|eslint|biome|ruff|flake8|pylint|mypy|go vet|vet|gofmt|prettier|clippy|type ?check(er|s|ing)?|tsc|shellcheck)\b[^.;,]{0,50}?\b(clean|pass(es|ed|ing)?|no (errors?|warnings?|issues|problems|complaints|findings)|succeed(s|ed)?|happy|green)\b|\bno (lint|linting|type|vet) (errors|issues|warnings|problems)\b`)},
	{KindBugFixed, regexp.MustCompile(`(?i)\b(fixed|resolved|patched|repaired)\b|\b(bug|issue|error|problem|regression)\b[^.;,]{0,30}\b(is|are|has been|have been|was) (now )?(fixed|resolved|gone)\b`)},
	{KindFileCreated, regexp.MustCompile(`(?i)\b(created|wrote|written|generated|saved|added)\b`)},
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
		if loc < 0 {
			continue
		}
		c := Claim{Text: sentence, Kind: kp.kind, Path: firstPath(sentence)}
		switch kp.kind {
		case KindTestsPass:
			if !tagged && reportsFailure(code) {
				continue
			}
		case KindFileCreated:
			c.Path = firstPath(sentence[loc:])
			if c.Path == "" && !mentionsFile(sentence) {
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
	for _, loc := range pattern.FindAllStringIndex(punct, -1) {
		if !tagged && hedgePattern.MatchString(code[:loc[1]]) {
			continue
		}
		if negation.MatchString(code[:loc[0]]) || negInside.MatchString(code[loc[0]:loc[1]]) {
			continue
		}
		return loc[0]
	}
	return -1
}

var fileWord = regexp.MustCompile(`(?i)\b(file|script|module|config|directory|folder)\b`)

func mentionsFile(sentence string) bool {
	return fileWord.MatchString(sentence)
}

func firstPath(s string) string {
	m := pathToken.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.Trim(m[1], "`'\"")
}

func reportsFailure(sentence string) bool {
	for _, loc := range failWord.FindAllStringIndex(sentence, -1) {
		if !zeroBefore.MatchString(sentence[:loc[0]]) {
			return true
		}
	}
	return false
}

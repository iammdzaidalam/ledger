package main

type Evidence struct {
	Ref        string                 `json:"ref"`
	Seq        int                    `json:"seq"`
	Tool       string                 `json:"tool"`
	Args       map[string]interface{} `json:"args"`
	RawStdout  string                 `json:"raw_stdout"`
	RawStderr  string                 `json:"raw_stderr"`
	ExitCode   *int                   `json:"exit_code"`
	Executed   bool                   `json:"executed"`
	IsError    bool                   `json:"is_error"`
	DurationMs int64                  `json:"duration_ms"`
	Diff       string                 `json:"diff,omitempty"`
}

type CheckRequest struct {
	RequestID string     `json:"request_id"`
	TurnText  string     `json:"turn_text"`
	Evidence  []Evidence `json:"evidence"`
	FreshRefs []string   `json:"fresh_refs"`
}

type Verdict string

const (
	Verified     Verdict = "verified"
	Contradicted Verdict = "contradicted"
	Unsupported  Verdict = "unsupported"
	Unverifiable Verdict = "unverifiable"
)

type ClaimKind string

const (
	KindTestsPass   ClaimKind = "tests_pass"
	KindFileCreated ClaimKind = "file_created"
	KindBugFixed    ClaimKind = "bug_fixed"
	KindLintClean   ClaimKind = "lint_clean"
	KindSuccess     ClaimKind = "command_success"
)

type Attribution string

const (
	ByTag     Attribution = "tag"
	ByMention Attribution = "mention"
	ByFamily  Attribution = "family"
	ByRecency Attribution = "recency"
	ByNone    Attribution = "none"
)

type ClaimResult struct {
	Text        string      `json:"text"`
	Kind        ClaimKind   `json:"kind"`
	Ref         string      `json:"ref,omitempty"`
	Attribution Attribution `json:"attribution"`
	Verdict     Verdict     `json:"verdict"`
	Rule        string      `json:"rule"`
	Reason      string      `json:"reason"`
}

type CheckResponse struct {
	RequestID string        `json:"request_id"`
	Claims    []ClaimResult `json:"claims"`
	Error     string        `json:"error,omitempty"`
}

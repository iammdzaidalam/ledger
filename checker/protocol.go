package main

// CheckRequest is one line of stdin: the raw evidence from a tool call plus
// whatever the model claimed about it in its next turn.
type CheckRequest struct {
	RequestID    string                 `json:"request_id"`
	Tool         string                 `json:"tool"`
	Args         map[string]interface{} `json:"args"`
	RawStdout    string                 `json:"raw_stdout"`
	RawStderr    string                 `json:"raw_stderr"`
	ExitCode     *int                   `json:"exit_code"`
	Executed     bool                   `json:"executed"`
	DurationMs   int64                  `json:"duration_ms"`
	ModelClaimed *string                `json:"model_claimed"`
}

type ClaimCheck struct {
	ModelClaimed *string `json:"model_claimed"`
	// bool or "unverifiable" - Go has no union type, this is the pragmatic bridge
	MatchesEvidence interface{} `json:"matches_evidence"`
}

// VerifiedResult is one line of stdout, echoing the request plus the verdict.
type VerifiedResult struct {
	RequestID  string                 `json:"request_id"`
	Tool       string                 `json:"tool"`
	Args       map[string]interface{} `json:"args"`
	RawStdout  string                 `json:"raw_stdout"`
	RawStderr  string                 `json:"raw_stderr"`
	ExitCode   *int                   `json:"exit_code"`
	Executed   bool                   `json:"executed"`
	DurationMs int64                  `json:"duration_ms"`
	ClaimCheck ClaimCheck             `json:"claim_check"`
}

func toVerifiedResult(req CheckRequest, check ClaimCheck) VerifiedResult {
	return VerifiedResult{
		RequestID:  req.RequestID,
		Tool:       req.Tool,
		Args:       req.Args,
		RawStdout:  req.RawStdout,
		RawStderr:  req.RawStderr,
		ExitCode:   req.ExitCode,
		Executed:   req.Executed,
		DurationMs: req.DurationMs,
		ClaimCheck: check,
	}
}

package main

import "strings"

// phrases the model might use even when the command actually failed
var successPhrases = []string{"done", "fixed", "pass", "success", "completed", "works now"}

// substrings that suggest a command is a test/build runner, where empty
// output is suspicious rather than normal
var runnerHints = []string{"test", "vitest", "pytest", "jest", "build"}

// Evaluate runs the three deterministic checks in priority order. Rule 1
// short-circuits everything else, per the PRD it's a hard block regardless
// of what the model says.
func Evaluate(req CheckRequest) ClaimCheck {
	if !req.Executed {
		return ClaimCheck{ModelClaimed: req.ModelClaimed, MatchesEvidence: false}
	}
	if claimsSuccessDespiteFailure(req) {
		return ClaimCheck{ModelClaimed: req.ModelClaimed, MatchesEvidence: false}
	}
	if outputMissingWhereExpected(req) {
		return ClaimCheck{ModelClaimed: req.ModelClaimed, MatchesEvidence: "unverifiable"}
	}
	return ClaimCheck{ModelClaimed: req.ModelClaimed, MatchesEvidence: true}
}

// rule 2: exit code says failure but the model's text uses success language
func claimsSuccessDespiteFailure(req CheckRequest) bool {
	if req.ExitCode == nil || *req.ExitCode == 0 || req.ModelClaimed == nil {
		return false
	}
	claim := strings.ToLower(*req.ModelClaimed)
	for _, phrase := range successPhrases {
		if strings.Contains(claim, phrase) {
			return true
		}
	}
	return false
}

// rule 3: no output at all from something that looks like a test/build command
func outputMissingWhereExpected(req CheckRequest) bool {
	if req.RawStdout != "" || req.RawStderr != "" {
		return false
	}
	return looksLikeRunnerCommand(req.Args)
}

func looksLikeRunnerCommand(args map[string]interface{}) bool {
	command, ok := args["command"].(string)
	if !ok {
		return false
	}
	lower := strings.ToLower(command)
	for _, hint := range runnerHints {
		if strings.Contains(lower, hint) {
			return true
		}
	}
	return false
}

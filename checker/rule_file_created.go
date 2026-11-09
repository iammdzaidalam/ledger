package main

import "strings"

func checkFileCreated(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string) {
	if !found && c.Path != "" {
		target, found = Latest(req.Evidence, func(e Evidence) bool {
			return e.Tool == "Bash" && strings.Contains(CommandOf(e), c.Path)
		})
	}
	if !found {
		if c.Path != "" {
			return Unsupported, "nothing wrote " + c.Path
		}
		return Unsupported, "no Write call in this session"
	}
	if c.Path != "" && target.Tool != "Bash" && !SamePath(c.Path, PathOf(target)) {
		return Unsupported, "nothing wrote " + c.Path + ", last write was " + PathOf(target)
	}
	if !Succeeded(target) {
		reason := Describe(target)
		if detail := strings.TrimSpace(target.RawStderr); detail != "" {
			reason += ": " + firstLine(detail)
		}
		return Contradicted, reason
	}
	return Verified, Describe(target)
}

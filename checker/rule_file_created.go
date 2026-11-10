package checker

import "strings"

func checkFileCreated(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string) {
	if !found {
		if c.Path != "" {
			return Unsupported, "nothing wrote " + c.Path
		}
		return Unsupported, "no Write call in this session"
	}
	if c.Path != "" && !writes(c, target) {
		return Unsupported, "nothing wrote " + c.Path + ", last write was " + PathOf(target)
	}
	if !Succeeded(target) {
		reason := Describe(target)
		if detail := strings.TrimSpace(target.RawStderr); detail != "" {
			reason += ": " + firstLine(detail)
		}
		return Contradicted, reason
	}
	if c.Modifies && !IsCommand(target) && strings.TrimSpace(target.Diff) == "" {
		if _, ok := Latest(req.Evidence, func(e Evidence) bool { return writes(c, e) && ChangedFiles(e) }); !ok {
			return Unsupported, Describe(target) + " but the diff is empty, nothing in the file changed"
		}
	}
	return Verified, Describe(target)
}

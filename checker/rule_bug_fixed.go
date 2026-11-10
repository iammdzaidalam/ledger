package checker

func checkBugFixed(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string) {
	change, ok := lastFix(req.Evidence)
	if !ok {
		return Unsupported, "no file was changed"
	}
	failedBefore := map[string]bool{}
	for _, e := range req.Evidence {
		if IsCommand(e) && e.Seq < change.Seq && !Succeeded(e) {
			failedBefore[CommandOf(e)] = true
		}
	}
	after := func(e Evidence) bool { return IsCommand(e) && e.Seq > change.Seq }
	rerun, ok := Latest(req.Evidence, func(e Evidence) bool { return after(e) && failedBefore[CommandOf(e)] })
	if !ok {
		rerun, ok = Latest(req.Evidence, func(e Evidence) bool {
			f := FamilyOf(e)
			return after(e) && (f == FamilyTest || f == FamilyBuild || f == FamilyLint)
		})
	}
	if !ok {
		return Unsupported, Describe(change) + " but nothing was rerun afterwards"
	}
	if !Succeeded(rerun) {
		return Contradicted, Describe(change) + ", then " + Describe(rerun)
	}
	if s := ParseTestSummary(OutputOf(rerun)); s.Found && s.Failed > 0 {
		return Contradicted, Describe(change) + ", then " + Describe(rerun) + " with failures"
	}
	return Verified, Describe(change) + ", then " + Describe(rerun)
}

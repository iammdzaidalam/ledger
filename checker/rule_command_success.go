package checker

func checkCommandSuccess(c Claim, target Evidence, found bool, req CheckRequest) (Verdict, string) {
	if Succeeded(target) {
		return Verified, Describe(target)
	}
	return Contradicted, Describe(target)
}

import type { VerifiedResult } from "./types.js";

// One line the terminal can print right after a flagged turn, since the
// whole point of the grounding layer is that this stays visible, not buried in a log.
export function formatFlag(result: VerifiedResult): string {
	const verdict =
		result.claim_check.matches_evidence === "unverifiable" ? "UNVERIFIABLE" : "UNVERIFIED CLAIM";
	const evidence = (result.raw_stderr || result.raw_stdout || "(no output)").slice(0, 300);
	return `[${verdict}] ${result.tool} exited ${result.exit_code ?? "n/a"} | model said: "${result.claim_check.model_claimed}" | evidence: ${evidence}`;
}

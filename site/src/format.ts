import type { Claim, Verdict } from "./types";

const CLI_LABELS: Record<Verdict, string> = {
	verified: "VERIFIED",
	contradicted: "FALSE CLAIM",
	unsupported: "UNSUPPORTED CLAIM",
	unverifiable: "UNVERIFIABLE",
};

export function formatFlag(claim: Claim): string {
	const quote = claim.text.length > 120 ? `${claim.text.slice(0, 117)}...` : claim.text;
	const ref = claim.ref ? ` ${claim.ref}` : "";
	return `[${CLI_LABELS[claim.verdict]}] ${claim.kind}${ref} | model said: "${quote}" | evidence: ${claim.reason}`;
}

export function cliLabel(verdict: Verdict): string {
	return CLI_LABELS[verdict];
}

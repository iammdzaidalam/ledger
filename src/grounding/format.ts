import type { ClaimResult } from "./types.js";

const LABELS: Record<ClaimResult["verdict"], string> = {
	verified: "VERIFIED",
	contradicted: "FALSE CLAIM",
	unsupported: "UNSUPPORTED CLAIM",
	unverifiable: "UNVERIFIABLE",
};

export function isFlag(claim: ClaimResult): boolean {
	return claim.verdict !== "verified";
}

export function formatFlag(claim: ClaimResult): string {
	const quote = claim.text.length > 120 ? `${claim.text.slice(0, 117)}...` : claim.text;
	const ref = claim.ref ? ` ${claim.ref}` : "";
	return `[${LABELS[claim.verdict]}] ${claim.kind}${ref} | model said: "${quote}" | evidence: ${claim.reason}`;
}

export function feedbackFor(claims: ClaimResult[]): string {
	const lines = claims.map((c) => `- "${c.text}" is ${c.verdict}: ${c.reason}`);
	return `Ledger checked your last message against the tool output and these claims do not hold up:\n${lines.join("\n")}\nRe-read the output and correct the record before continuing.`;
}

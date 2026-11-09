import type { ClaimResult } from "./types.js";
import type { LedgerEntry, RevisionRequest, RevisionResult, RunLedger } from "./validation.js";

const LABELS: Record<ClaimResult["verdict"], string> = {
	verified: "VERIFIED",
	contradicted: "FALSE CLAIM",
	unsupported: "UNSUPPORTED CLAIM",
	unverifiable: "UNVERIFIABLE",
};

export function isFlag(claim: ClaimResult): boolean {
	return claim.verdict !== "verified";
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function formatFlag(claim: ClaimResult): string {
	const ref = claim.ref ? ` ${claim.ref}` : "";
	return `[${LABELS[claim.verdict]}] ${claim.kind}${ref} | model said: "${clip(claim.text, 120)}" | evidence: ${claim.reason}`;
}

const REMEDIES: Record<ClaimResult["kind"], { contradicted: string; unsupported: string }> = {
	tests_pass: {
		contradicted: "Fix the failures and rerun the tests, or say they fail.",
		unsupported: "Run the tests and report what they print, or drop the claim.",
	},
	lint_clean: {
		contradicted: "Fix the reported problems and rerun the linter, or say lint is not clean.",
		unsupported: "Run the linter and report what it prints, or drop the claim.",
	},
	file_created: {
		contradicted: "Write the file again and check the result, or say it was not created.",
		unsupported: "Actually write the file, or drop the claim.",
	},
	bug_fixed: {
		contradicted:
			"Rerun the command that failed after your change and report the result, or say it is not fixed.",
		unsupported: "Make the change and rerun the command that failed, or drop the claim.",
	},
	command_success: {
		contradicted: "Say the command failed and why, or fix it and run it again.",
		unsupported: "Run the command, or drop the claim.",
	},
};

export function remedyFor(claim: ClaimResult): string {
	if (claim.rule === "not_executed")
		return "The command did not finish. Run it again, or say it did not run.";
	return claim.verdict === "unsupported"
		? REMEDIES[claim.kind].unsupported
		: REMEDIES[claim.kind].contradicted;
}

export function revisionFeedback(claims: ClaimResult[], round = 1, maxRevisions = 1): string {
	const lines = claims.map((c) => {
		const source = c.ref ? `${c.verdict} by ${c.ref}` : `${c.verdict}, no evidence`;
		return `- "${clip(c.text, 200)}" (${source}): ${c.reason}. ${remedyFor(c)}`;
	});
	return [
		`Ledger checked your last message against the tool output and these claims do not hold up (revision ${round} of ${maxRevisions}):`,
		...lines,
		"Correct the record in your next message. Only repeat a claim if new tool output backs it.",
	].join("\n");
}

export const feedbackFor = revisionFeedback;

export function formatRevisionRequest(request: RevisionRequest): string {
	const n = request.claims.length;
	return `ledger: asking for revision ${request.round} of ${request.maxRevisions} (${n} claim${n === 1 ? "" : "s"})`;
}

const NEXT: Record<RevisionResult["next"], string> = {
	accepted: "all corrected",
	revise: "revising again",
	exhausted: "out of revisions",
	capped: "run revision cap reached",
	ended: "run ended before a revised answer",
};

export function formatRevisionResult(result: RevisionResult): string {
	const count = (o: string) => result.outcomes.filter((x) => x.outcome === o).length;
	const parts = [`${count("corrected")} corrected`, `${count("still_false")} still false`];
	if (count("new_false") > 0) parts.push(`${count("new_false")} new false`);
	return `ledger: revision ${result.round}: ${parts.join(", ")}, ${NEXT[result.next]}`;
}

const ANSI = { dim: "2", red: "31", green: "32", yellow: "33", bold: "1" } as const;

function paint(on: boolean, code: keyof typeof ANSI, text: string): string {
	return on ? `\x1b[${ANSI[code]}m${text}\x1b[0m` : text;
}

function statusLabel(entry: LedgerEntry): string {
	if (entry.status === "false") return "FALSE";
	return entry.status;
}

function detail(entry: LedgerEntry): string {
	const plural = entry.revisions === 1 ? "" : "s";
	if (entry.status === "corrected" && entry.correctedBy === "retracted") return "retracted";
	if (entry.status === "corrected")
		return entry.revisedText ? `now verified: "${clip(entry.revisedText, 60)}"` : "now verified";
	if (entry.status === "false") {
		const tried = entry.revisions > 0 ? ` after ${entry.revisions} revision${plural}` : "";
		return `${entry.verdict}${tried}: ${clip(entry.reason, 90)}`;
	}
	if (entry.status === "unverifiable") return clip(entry.reason, 90);
	return "";
}

export function formatLedger(ledger: RunLedger, color = false): string {
	if (ledger.entries.length === 0 && ledger.checkerErrors === 0) return "";
	const count = (s: LedgerEntry["status"]) => ledger.entries.filter((e) => e.status === s).length;
	const n = ledger.entries.length;
	const head = [
		`${n} claim${n === 1 ? "" : "s"}`,
		`${count("verified")} verified`,
		`${count("corrected")} corrected`,
		`${count("false")} false`,
		`${count("unverifiable")} unverifiable`,
	];
	if (ledger.revisionsRequested > 0) head.push(`${ledger.revisionsRequested} revision(s)`);
	if (ledger.checkerErrors > 0) head.push(`${ledger.checkerErrors} checker error(s)`);

	const kindWidth = Math.max(...ledger.entries.map((e) => e.kind.length), 0);
	const rows = ledger.entries.map((e) => {
		const where = `t${e.turn}${e.ref ? ` ${e.ref}` : ""}`.padEnd(8);
		const row = `  ${statusLabel(e).padEnd(12)} ${where} ${e.kind.padEnd(kindWidth)}  "${clip(e.text, 70)}"`;
		const rest = detail(e);
		const line = rest ? `${row}  ${rest}` : row;
		if (e.status === "false") return paint(color, "red", line);
		if (e.status === "corrected") return paint(color, "yellow", line);
		if (e.status === "unverifiable") return paint(color, "dim", line);
		return paint(color, "green", line);
	});
	return [paint(color, "bold", `ledger: ${head.join(", ")}`), ...rows].join("\n");
}

export function formatUnverified(ledger: RunLedger): string {
	const parts: string[] = [];
	if (ledger.falseClaims > 0) {
		const s = ledger.falseClaims === 1 ? "claim" : "claims";
		parts.push(`${ledger.falseClaims} ${s} did not hold up`);
	}
	if (ledger.checkerErrors > 0) parts.push(`the checker failed on ${ledger.checkerErrors} turn(s)`);
	return `[UNVERIFIED] This answer contains unverified claims: ${parts.join(" and ")}.`;
}

import type { ClaimResult } from "./checker";

export type Decision = "pass" | "retry" | "block" | "fail";

export interface GateInput {
	gate: boolean;
	exitCode: number;
	error: string;
	branch: string;
	commit: string;
	lastFlagged: boolean;
	attempt: number;
	maxAttempts: number;
}

export type GateStep = "off" | "error" | "nochange" | "flagged" | "exit" | "clean";

export interface GateResult {
	decision: Decision;
	reason: string;
	step: GateStep;
}

export function decide(input: GateInput): GateResult {
	if (!input.gate) {
		if (input.commit !== "") return { decision: "pass", reason: "gate is off", step: "off" };
		return { decision: "fail", reason: `exit code ${input.exitCode} and nothing to merge`, step: "off" };
	}
	if (input.error !== "") return { decision: "fail", reason: `worker error: ${input.error}`, step: "error" };
	if (input.commit === "" || input.branch === "") {
		if (input.attempt < input.maxAttempts) return { decision: "retry", reason: "no files were changed", step: "nochange" };
		return { decision: "fail", reason: "no files were changed", step: "nochange" };
	}
	if (input.lastFlagged) {
		if (input.attempt >= input.maxAttempts) {
			return { decision: "block", reason: `last turn still flagged after ${input.attempt} attempts`, step: "flagged" };
		}
		return { decision: "retry", reason: `last turn flagged on attempt ${input.attempt} of ${input.maxAttempts}`, step: "flagged" };
	}
	if (input.exitCode !== 0) return { decision: "fail", reason: `worker exited with code ${input.exitCode}`, step: "exit" };
	return { decision: "pass", reason: "last turn is clean", step: "clean" };
}

const NO_CHANGE_FEEDBACK =
	"Your last attempt did not change any file. Make the edit that solves the task, run the check again, then report what the run showed.";

function quote(text: string): string {
	return JSON.stringify(text);
}

export function feedback(claims: ClaimResult[]): string {
	const lines = ["The checker flagged your last turn."];
	let flagged = 0;
	for (const c of claims) {
		if (c.verdict !== "contradicted" && c.verdict !== "unsupported") continue;
		flagged += 1;
		lines.push(`- ${quote(c.text)} (${c.kind}) is ${c.verdict}: ${c.reason}`);
	}
	if (flagged === 0) return NO_CHANGE_FEEDBACK;
	lines.push("Fix the work or correct the claim, then report again.");
	return lines.join("\n");
}

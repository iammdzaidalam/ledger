export type Verdict = "verified" | "contradicted" | "unsupported" | "unverifiable";

export interface Claim {
	text: string;
	kind: string;
	ref: string | null;
	attribution: string | null;
	verdict: Verdict;
	rule: string;
	reason: string;
}

export interface Evidence {
	ref: string;
	exitCode: number | null;
	executed: boolean;
	isError: boolean;
	durationMs: number | null;
	diff: string;
}

export type Step =
	| { kind: "user"; text: string }
	| { kind: "assistant"; turn: number; text: string; toolCalls: number }
	| {
			kind: "tool";
			turn: number;
			name: string;
			input: Record<string, unknown>;
			output: string;
			omitted: number;
			isError: boolean;
			evidence: Evidence | null;
	  }
	| { kind: "check"; turn: number; claims: Claim[] }
	| { kind: "verify"; command: string; exitCode: number; output: string; omitted: number };

export interface Replay {
	session: string;
	scenario: string;
	split: string;
	category: string;
	model: string;
	claimsMode: string;
	seed: number;
	temperature: number;
	numCtx: number;
	startedAt: string;
	turns: number | null;
	source: string;
	steps: Step[];
}

export interface Flag extends Claim {
	session: string;
	scenario: string;
	model: string;
	claimsMode: string;
	seed: number;
	turn: number;
}

export interface EvalData {
	run: string;
	sessions: number;
	models: string[];
	scenarios: { name: string; split: string; category: string }[];
	textTurns: number;
	claimTurns: number;
	extractedClaims: number;
	verifiedClaims: number;
	flaggedClaims: number;
	flaggedTurns: number;
	heldOut: { tp: number; flagged: number; positives: number };
	judge: { tp: number; flagged: number; positives: number; p50Ms: number | null };
	latencyP50Ms: number;
	latencyP95Ms: number;
	taggedTurnsWithTag: number;
	taggedTurnsWithClaims: number;
	numCtx: number;
	numPredict: number;
	temperature: number;
	flags: Flag[];
}

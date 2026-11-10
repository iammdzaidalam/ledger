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
	scale: { sessions: number; turns: number; precision: number; recall: number; judgePrecision: number; judgeRecall: number };
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

export interface FleetArm {
	swarms: number;
	tasks: number;
	verified: { n: number; pct: number; lo: number; hi: number };
	stillFailing: { n: number; of: number; pct: number };
	blocked: number;
	failed: number;
	attempts: string;
	wallMin: string;
}

export interface FleetData {
	swarms: number;
	tasksPerArm: number;
	model: string;
	bug: { on: FleetArm; off: FleetArm };
	control: { on: FleetArm; off: FleetArm };
	retries: number;
	failures: number;
	check: { rate: string; p50: string; clients: number };
	recordTurn: { rate: string; p50: string; clients: number };
}

export interface SwarmEvent {
	at: number;
	order: number;
	type: string;
	task: number | null;
	attempt: number | null;
	message: string;
	data: Record<string, unknown>;
}

export interface SwarmTask {
	idx: number;
	scenario: string;
	prompt: string;
	state: string;
	attempts: number;
	verifyPassed: boolean;
	branch: string;
	commit: string;
	doneAt: number;
}

export interface Swarm {
	id: string;
	short: string;
	group: string;
	seed: number;
	gate: boolean;
	model: string;
	goal: string;
	maxAttempts: number;
	seconds: number;
	tasks: SwarmTask[];
	events: SwarmEvent[];
}

export interface SwarmArgs {
	goal?: string;
	workers: number;
	server?: string;
	gate: boolean;
	maxAttempts?: number;
	plan?: number;
	subtasks: string[];
	base?: string;
	json: boolean;
	resume?: string;
	provider?: string;
	model?: string;
}

const VALUE_FLAGS = new Set([
	"--workers",
	"--server",
	"--max-attempts",
	"--plan",
	"--subtask",
	"--base",
	"--resume",
	"--provider",
	"--model",
]);

function whole(flag: string, value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1)
		throw new Error(`${flag} must be a whole number of at least 1, got: ${value}`);
	return n;
}

export function parseSwarmArgs(argv: string[]): SwarmArgs {
	const result: SwarmArgs = { workers: 3, gate: true, subtasks: [], json: false };
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (VALUE_FLAGS.has(arg)) {
			const value = argv[++i];
			if (value === undefined || (value.startsWith("-") && arg !== "--subtask")) {
				throw new Error(`${arg} needs a value`);
			}
			if (arg === "--workers") result.workers = whole(arg, value);
			else if (arg === "--max-attempts") result.maxAttempts = whole(arg, value);
			else if (arg === "--plan") result.plan = whole(arg, value);
			else if (arg === "--subtask") result.subtasks.push(value);
			else if (arg === "--server") result.server = value;
			else if (arg === "--base") result.base = value;
			else if (arg === "--resume") result.resume = value;
			else if (arg === "--provider") result.provider = value;
			else result.model = value;
		} else if (arg === "--no-gate") result.gate = false;
		else if (arg === "--json") result.json = true;
		else rest.push(arg);
	}
	if (rest.length > 0) result.goal = rest.join(" ");
	if (result.plan !== undefined && result.subtasks.length > 0) {
		throw new Error("--plan and --subtask cannot be used together");
	}
	if (!result.goal && !result.resume) throw new Error('swarm needs a goal: ledger swarm "<goal>"');
	return result;
}

import type { SwarmArgs } from "./args.js";
import { runCoordinator } from "./coordinator.js";
import { formatSummary } from "./report.js";

export const DEFAULT_SERVER = "http://localhost:8080";
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface ModelChoice {
	provider: string;
	model: string;
}

export async function runSwarmCommand(args: SwarmArgs, choice: ModelChoice): Promise<number> {
	const controller = new AbortController();
	let interrupts = 0;
	const onSigint = () => {
		if (++interrupts > 1) process.exit(130);
		process.stderr.write("\nCancelling the swarm. Press Ctrl-C again to quit now.\n");
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	try {
		const outcome = await runCoordinator({
			cwd: process.cwd(),
			server: args.server ?? process.env.LEDGER_SERVER ?? DEFAULT_SERVER,
			goal: args.goal,
			workers: args.workers,
			gate: args.gate,
			maxAttempts: args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			plan: args.plan,
			subtasks: args.subtasks,
			base: args.base,
			resume: args.resume,
			provider: choice.provider,
			model: choice.model,
			signal: controller.signal,
			log: (line) => process.stderr.write(`${line}\n`),
		});
		if (args.json) process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
		else process.stdout.write(`\n${formatSummary(outcome.result, outcome.branch)}\n`);
		return outcome.exitCode;
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}

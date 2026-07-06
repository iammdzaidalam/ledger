import { createInterface } from "node:readline/promises";
import { consola } from "consola";
import { runAgent } from "../agent/loop.js";
import { formatFlag } from "../grounding/format.js";
import type { Message } from "../types.js";

export interface InteractiveOptions {
	providerName: string;
	model: string;
	system: string;
	initialMessage?: string;
	maxTurns?: number;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const history: Message[] = [];

	console.log(`ledger (${options.providerName}/${options.model}). Ctrl+C to quit.\n`);

	let nextInput = options.initialMessage;
	while (true) {
		const input = nextInput ?? (await rl.question("> "));
		nextInput = undefined;
		if (!input.trim()) continue;

		history.push({ role: "user", content: input });

		for await (const event of runAgent({
			providerName: options.providerName,
			model: options.model,
			system: options.system,
			messages: history,
			maxTurns: options.maxTurns,
		})) {
			if (event.type === "text_delta") process.stdout.write(event.delta);
			if (event.type === "tool_start") consola.info(`\n[${event.name}] ${JSON.stringify(event.input)}`);
			if (event.type === "tool_end" && event.isError) consola.warn(`[${event.name}] failed: ${event.result}`);
			if (event.type === "grounding_flag") consola.error(formatFlag(event.result));
			if (event.type === "agent_end") {
				history.length = 0;
				history.push(...event.messages);
			}
		}
		process.stdout.write("\n\n");
	}
}

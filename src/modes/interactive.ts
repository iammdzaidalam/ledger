import { createInterface } from "node:readline/promises";
import { consola } from "consola";
import { runAgent } from "../agent/loop.js";
import { GroundingClient } from "../grounding/client.js";
import { EvidenceLog } from "../grounding/evidence.js";
import { formatFlag } from "../grounding/format.js";
import type { ClaimsMode } from "../grounding/types.js";
import { appendMessage } from "../session/store.js";
import type { Message } from "../types.js";

export interface InteractiveOptions {
	providerName: string;
	model: string;
	system: string;
	initialMessage?: string;
	maxTurns?: number;
	claimsMode?: ClaimsMode;
	feedback?: boolean;
	sessionPath: string;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const groundingClient = new GroundingClient();
	const evidence = new EvidenceLog();
	const history: Message[] = [];

	// Ctrl+C bypasses any try/finally further down, since Node kills the
	// process before an in-flight await ever resolves or rejects.
	const shutdown = () => {
		groundingClient.close();
		rl.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);

	console.log(`ledger (${options.providerName}/${options.model}). Ctrl+C to quit.\n`);

	try {
		let nextInput = options.initialMessage;
		while (true) {
			const input = nextInput ?? (await rl.question("> "));
			nextInput = undefined;
			if (!input.trim()) continue;

			const userMessage: Message = { role: "user", content: input };
			history.push(userMessage);
			await appendMessage(options.sessionPath, userMessage);
			const turnStart = history.length;

			for await (const event of runAgent({
				providerName: options.providerName,
				model: options.model,
				system: options.system,
				messages: history,
				maxTurns: options.maxTurns,
				groundingClient,
				evidence,
				claimsMode: options.claimsMode,
				feedback: options.feedback,
			})) {
				if (event.type === "text_delta") process.stdout.write(event.delta);
				if (event.type === "tool_start") consola.info(`\n[${event.name}] ${JSON.stringify(event.input)}`);
				if (event.type === "tool_end" && event.isError)
					consola.warn(`[${event.name}] failed: ${event.result}`);
				if (event.type === "grounding_flag") consola.error(formatFlag(event.claim));
				if (event.type === "agent_end") {
					// event.messages is the whole conversation runAgent built from
					// `history`, so only the tail past turnStart is new this round
					// (the user message above was already recorded).
					for (const m of event.messages.slice(turnStart)) await appendMessage(options.sessionPath, m);
					history.length = 0;
					history.push(...event.messages);
				}
			}
			process.stdout.write("\n\n");
		}
	} finally {
		// covers stdin closing (Ctrl+D) - SIGINT is handled separately above
		groundingClient.close();
		process.removeListener("SIGINT", shutdown);
	}
}

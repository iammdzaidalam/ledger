import { consola } from "consola";
import { runAgent } from "../agent/loop.js";
import { GroundingClient } from "../grounding/client.js";
import { formatFlag } from "../grounding/format.js";
import { appendMessage } from "../session/store.js";
import type { Message } from "../types.js";

export interface PrintOptions {
	providerName: string;
	model: string;
	system: string;
	message: string;
	maxTurns?: number;
	sessionPath?: string;
}

export async function runPrint(options: PrintOptions): Promise<void> {
	const userMessage: Message = { role: "user", content: options.message };
	if (options.sessionPath) await appendMessage(options.sessionPath, userMessage);

	const groundingClient = new GroundingClient();

	try {
		for await (const event of runAgent({
			providerName: options.providerName,
			model: options.model,
			system: options.system,
			messages: [userMessage],
			maxTurns: options.maxTurns,
			groundingClient,
		})) {
			if (event.type === "text_delta") process.stdout.write(event.delta);
			if (event.type === "tool_start") consola.info(`\n[${event.name}] ${JSON.stringify(event.input)}`);
			if (event.type === "tool_end" && event.isError) consola.warn(`[${event.name}] failed: ${event.result}`);
			if (event.type === "grounding_flag") consola.error(formatFlag(event.result));
			if (event.type === "agent_end" && options.sessionPath) {
				const last = event.messages.at(-1);
				if (last) await appendMessage(options.sessionPath, last);
			}
		}
	} finally {
		// one-shot mode has no more turns coming, so the checker subprocess
		// should not be left running after we exit
		groundingClient.close();
	}
	process.stdout.write("\n");
}

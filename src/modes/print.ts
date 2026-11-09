import { consola } from "consola";
import { runAgent } from "../agent/loop.js";
import { GroundingClient } from "../grounding/client.js";
import { EvidenceLog } from "../grounding/evidence.js";
import { formatFlag } from "../grounding/format.js";
import type { ClaimsMode } from "../grounding/types.js";
import { appendMessage } from "../session/store.js";
import type { Message } from "../types.js";

export interface PrintOptions {
	providerName: string;
	model: string;
	system: string;
	message: string;
	maxTurns?: number;
	claimsMode?: ClaimsMode;
	feedback?: boolean;
	sessionPath?: string;
}

export async function runPrint(options: PrintOptions): Promise<void> {
	const userMessage: Message = { role: "user", content: options.message };
	if (options.sessionPath) await appendMessage(options.sessionPath, userMessage);

	const groundingClient = new GroundingClient();
	const evidence = new EvidenceLog();

	try {
		for await (const event of runAgent({
			providerName: options.providerName,
			model: options.model,
			system: options.system,
			messages: [userMessage],
			maxTurns: options.maxTurns,
			groundingClient,
			evidence,
			claimsMode: options.claimsMode,
			feedback: options.feedback,
		})) {
			if (event.type === "text_delta") process.stdout.write(event.delta);
			if (event.type === "tool_start") consola.info(`\n[${event.name}] ${JSON.stringify(event.input)}`);
			if (event.type === "tool_end" && event.isError) consola.warn(`[${event.name}] failed: ${event.result}`);
			if (event.type === "grounding_flag") consola.error(formatFlag(event.claim));
			if (event.type === "agent_end" && options.sessionPath) {
				for (const m of event.messages.slice(1)) await appendMessage(options.sessionPath, m);
			}
		}
	} finally {
		// one-shot mode has no more turns coming, so the checker subprocess
		// should not be left running after we exit
		groundingClient.close();
	}
	process.stdout.write("\n");
}

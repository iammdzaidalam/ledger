import { extractClaimText } from "../grounding/claim-extractor.js";
import { createProvider } from "../providers/index.js";
import { getTool, getToolDefinitions } from "../tools/index.js";
import type { RawExecution } from "../tools/types.js";
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../types.js";
import type { AgentEvent, AgentOptions } from "./types.js";

const DEFAULT_MAX_TURNS = 20;

// Core loop: stream a completion, run whatever tools the model asked for,
// feed the results back in as a new turn, repeat until it stops calling tools.
export async function* runAgent(options: AgentOptions): AsyncGenerator<AgentEvent> {
	const provider = createProvider(options.providerName, getApiKey(options.providerName));
	const tools = getToolDefinitions();
	const messages: Message[] = [...options.messages];
	let turns = 0;
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

	// bash results awaiting a claim to check against, since the claim always
	// shows up in the model's *next* text turn, so this can't be checked inline.
	const grounding = options.groundingClient;
	const pendingBashResults = new Map<string, RawExecution>();

	yield { type: "agent_start" };

	while (turns < maxTurns) {
		turns++;
		const assistantBlocks: ContentBlock[] = [];
		const pendingToolCalls: Record<string, { name: string; inputJson: string }> = {};

		for await (const event of provider.complete({
			model: options.model,
			system: options.system,
			messages,
			tools,
			max_tokens: 8192,
		})) {
			if (event.type === "text_delta") {
				yield { type: "text_delta", delta: event.delta };
				const last = assistantBlocks.at(-1);
				if (last?.type === "text") last.text += event.delta;
				else assistantBlocks.push({ type: "text", text: event.delta });
			}

			if (event.type === "tool_use_start") {
				pendingToolCalls[event.id] = { name: event.name, inputJson: "" };
			}

			if (event.type === "tool_use_input_delta") {
				const pending = pendingToolCalls[event.id];
				if (pending) pending.inputJson += event.delta;
			}

			if (event.type === "tool_use_end") {
				const tc = pendingToolCalls[event.id];
				if (!tc) continue;
				const parsedInput = JSON.parse(tc.inputJson || "{}");
				assistantBlocks.push({ type: "tool_use", id: event.id, name: tc.name, input: parsedInput });
			}

			if (event.type === "message_end") {
				yield { type: "turn_end", stop_reason: event.stop_reason, usage: event.usage };
			}
		}

		messages.push({ role: "assistant", content: assistantBlocks });

		// This turn's text is the model's claim about whatever bash calls are
		// still pending from the previous round, so check it before doing anything else.
		if (pendingBashResults.size > 0) {
			const claimed = extractClaimText(assistantBlocks);
			for (const exec of pendingBashResults.values()) {
				const verified = await grounding.check({ tool: "Bash", ...exec, model_claimed: claimed });
				if (verified.claim_check.matches_evidence !== true) {
					yield { type: "grounding_flag", result: verified };
				}
			}
			pendingBashResults.clear();
		}

		// Decide continuation by what blocks actually came back, not the stop
		// reason, since that keeps one rule true across every provider, even
		// ones (like Gemini) whose reported stop reason can't be trusted.
		const hasToolCalls = assistantBlocks.some((b) => b.type === "tool_use");
		if (!hasToolCalls) break;

		const toolResultBlocks: ToolResultBlock[] = [];

		for (const block of assistantBlocks) {
			if (block.type !== "tool_use") continue;
			const toolCall = block as ToolUseBlock;

			yield { type: "tool_start", id: toolCall.id, name: toolCall.name, input: toolCall.input };

			const tool = getTool(toolCall.name);
			let result: { output: string; isError: boolean };
			if (!tool) {
				result = { output: `Unknown tool: ${toolCall.name}`, isError: true };
			} else {
				const meta =
					toolCall.name === "Bash"
						? { onExecution: (exec: RawExecution) => pendingBashResults.set(toolCall.id, exec) }
						: undefined;
				result = await tool.execute(toolCall.input, meta).catch((err) => ({
					output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				}));
			}

			yield {
				type: "tool_end",
				id: toolCall.id,
				name: toolCall.name,
				result: result.output,
				isError: result.isError,
			};

			toolResultBlocks.push({
				type: "tool_result",
				tool_use_id: toolCall.id,
				content: result.output,
				is_error: result.isError,
			});
		}

		messages.push({ role: "user", content: toolResultBlocks });
	}

	yield { type: "agent_end", messages };
}

export function getApiKey(providerName: string): string {
	const envKey =
		providerName === "claude"
			? "ANTHROPIC_API_KEY"
			: providerName === "gemini"
				? "GEMINI_API_KEY"
				: "GROQ_API_KEY";
	const key = process.env[envKey];
	if (!key) throw new Error(`Missing env var: ${envKey}`);
	return key;
}

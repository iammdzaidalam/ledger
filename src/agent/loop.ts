import { feedbackFor, isFlag } from "../grounding/format.js";
import type { ClaimResult } from "../grounding/types.js";
import { createProvider } from "../providers/index.js";
import { getTool, getToolDefinitions } from "../tools/index.js";
import type { RawExecution, ToolResult } from "../tools/types.js";
import type { ContentBlock, Message, ToolResultBlock } from "../types.js";
import type { AgentEvent, AgentOptions } from "./types.js";

const DEFAULT_MAX_TURNS = 20;
const EVIDENCE_TOOLS = new Set(["Bash", "Write", "Edit"]);

function textOf(blocks: ContentBlock[]): string {
	return blocks
		.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

// Core loop: stream a completion, run whatever tools the model asked for,
// feed the results back in as a new turn, repeat until it stops calling tools.
export async function* runAgent(options: AgentOptions): AsyncGenerator<AgentEvent> {
	const provider = options.provider ?? createProvider(options.providerName, getApiKey(options.providerName));
	const tools = getToolDefinitions();
	const messages: Message[] = [...options.messages];
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const tagged = options.claimsMode === "tagged";
	let feedbackSent = false;

	yield { type: "agent_start" };

	for (let turn = 1; turn <= maxTurns; turn++) {
		const assistantBlocks: ContentBlock[] = [];
		const pendingToolCalls: Record<string, { name: string; inputJson: string }> = {};

		for await (const event of provider.complete({
			model: options.model,
			system: options.system,
			messages,
			tools,
			max_tokens: 8192,
			temperature: options.temperature,
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
				assistantBlocks.push({
					type: "tool_use",
					id: event.id,
					name: tc.name,
					input: parseInput(tc.inputJson),
				});
			}

			if (event.type === "message_end") {
				yield { type: "turn_end", stop_reason: event.stop_reason, usage: event.usage };
			}
		}

		messages.push({ role: "assistant", content: assistantBlocks });

		const text = textOf(assistantBlocks);
		const toolCalls = assistantBlocks.filter((b) => b.type === "tool_use");
		yield { type: "assistant_turn", turn, text, toolCalls: toolCalls.length };

		let flags: ClaimResult[] = [];
		if (text) {
			const startedAt = performance.now();
			const response = await options.groundingClient.check({
				turn_text: text,
				evidence: options.evidence.all(),
				fresh_refs: options.evidence.takeFresh(),
			});
			yield {
				type: "grounding_check",
				turn,
				claims: response.claims,
				error: response.error,
				latencyMs: performance.now() - startedAt,
			};
			flags = response.claims.filter(isFlag);
			for (const claim of flags) yield { type: "grounding_flag", claim };
		}
		const feedback = options.feedback && flags.length > 0 ? feedbackFor(flags) : null;

		if (toolCalls.length === 0) {
			if (!feedback || feedbackSent) break;
			feedbackSent = true;
			messages.push({ role: "user", content: feedback });
			continue;
		}

		const toolResultBlocks: ToolResultBlock[] = [];

		for (const toolCall of toolCalls) {
			if (toolCall.type !== "tool_use") continue;
			yield { type: "tool_start", id: toolCall.id, name: toolCall.name, input: toolCall.input };

			const tool = getTool(toolCall.name);
			let execution: RawExecution | undefined;
			let result: ToolResult;
			if (!tool) {
				result = { output: `Unknown tool: ${toolCall.name}`, isError: true };
			} else {
				result = await tool
					.execute(toolCall.input, {
						onExecution: (exec) => {
							execution = exec;
						},
					})
					.catch((err) => ({
						output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
						isError: true,
					}));
			}

			let output = result.output;
			if (execution && EVIDENCE_TOOLS.has(toolCall.name)) {
				const entry = options.evidence.record(toolCall.name, execution);
				yield { type: "evidence", entry };
				if (tagged) output = `[ref ${entry.ref}]\n${output}`;
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
				content: output,
				is_error: result.isError,
			});
		}

		const lastResult = toolResultBlocks.at(-1);
		if (feedback && lastResult) lastResult.content += `\n\n${feedback}`;
		messages.push({ role: "user", content: toolResultBlocks });
	}

	yield { type: "agent_end", messages };
}

function parseInput(json: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(json || "{}");
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function getApiKey(providerName: string): string {
	if (providerName === "ollama") return "";
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

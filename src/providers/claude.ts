// Claude provider, wraps @anthropic-ai/sdk.
// Content blocks already match our internal shape, so barely any translation happens here.

import Anthropic from "@anthropic-ai/sdk";
import { consola } from "consola";
import type { ContentBlock, Message, StopReason } from "../types.js";

type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
type AnthropicContentParam =
	| Anthropic.TextBlockParam
	| Anthropic.ToolUseBlockParam
	| Anthropic.ToolResultBlockParam;

import type { CompletionOptions, Provider, StreamEvent } from "./types.js";

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
	return messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			const role = m.role as "user" | "assistant";
			if (typeof m.content === "string") return { role, content: m.content };

			const content = m.content.map((block: ContentBlock): AnthropicContentParam => {
				if (block.type === "text") return { type: "text", text: block.text };
				if (block.type === "tool_use") {
					return { type: "tool_use", id: block.id, name: block.name, input: block.input };
				}
				return {
					type: "tool_result",
					tool_use_id: block.tool_use_id,
					content: block.content,
					is_error: block.is_error,
				};
			});

			return { role, content };
		});
}

function toStopReason(reason: AnthropicStopReason): StopReason {
	if (reason === "tool_use") return "tool_use";
	if (reason === "max_tokens") return "max_tokens";
	if (reason === "stop_sequence") return "stop_sequence";
	return "end_turn";
}

export function createClaudeProvider(apiKey: string): Provider {
	const client = new Anthropic({ apiKey });

	return {
		name: "claude",

		async *complete(options: CompletionOptions): AsyncGenerator<StreamEvent> {
			const tools: Anthropic.Tool[] = options.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.input_schema as Anthropic.Tool.InputSchema,
			}));

			consola.debug(`claude: ${options.model}, ${options.messages.length} turns, ${tools.length} tools`);

			const stream = client.messages.stream({
				model: options.model,
				system: options.system,
				messages: toAnthropicMessages(options.messages),
				tools: tools.length > 0 ? tools : undefined,
				max_tokens: options.max_tokens,
				temperature: options.temperature,
			});

			// track which content_block index is text vs tool_use so deltas route right
			const blockKinds: Record<number, "text" | "tool_use"> = {};
			const blockIds: Record<number, string> = {};
			let inputTokens = 0;

			for await (const event of stream) {
				// input_tokens only shows up once, on message_start; message_delta
				// only ever carries a running output_tokens total.
				if (event.type === "message_start") {
					inputTokens = event.message.usage.input_tokens ?? 0;
				}

				if (event.type === "content_block_start") {
					if (event.content_block.type === "tool_use") {
						blockKinds[event.index] = "tool_use";
						blockIds[event.index] = event.content_block.id;
						yield { type: "tool_use_start", id: event.content_block.id, name: event.content_block.name };
					} else {
						blockKinds[event.index] = "text";
					}
				}

				if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						yield { type: "text_delta", delta: event.delta.text };
					}
					if (event.delta.type === "input_json_delta") {
						const id = blockIds[event.index];
						if (id) yield { type: "tool_use_input_delta", id, delta: event.delta.partial_json };
					}
				}

				if (event.type === "content_block_stop") {
					if (blockKinds[event.index] === "tool_use") {
						const id = blockIds[event.index];
						if (id) yield { type: "tool_use_end", id };
					}
				}

				if (event.type === "message_delta") {
					yield {
						type: "message_end",
						stop_reason: toStopReason(event.delta.stop_reason),
						usage: { input_tokens: inputTokens, output_tokens: event.usage.output_tokens ?? 0 },
					};
				}
			}
		},
	};
}

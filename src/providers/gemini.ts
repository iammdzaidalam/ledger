// Gemini provider, wraps @google/genai.
// System prompt goes in config.systemInstruction, not in the messages array.

import { GoogleGenAI } from "@google/genai";
import { consola } from "consola";
import type { ContentBlock } from "../types.js";
import type { CompletionOptions, Provider, StreamEvent } from "./types.js";

function toGeminiContents(messages: CompletionOptions["messages"]) {
	// Gemini matches a functionResponse to its call by function name, not by id,
	// so look up the name of the tool_use each result answers.
	const toolNames = new Map<string, string>();
	for (const m of messages) {
		if (typeof m.content === "string") continue;
		for (const block of m.content) {
			if (block.type === "tool_use") toolNames.set(block.id, block.name);
		}
	}

	return messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			const role = m.role === "assistant" ? "model" : "user";

			if (typeof m.content === "string") {
				return { role, parts: [{ text: m.content }] };
			}

			const parts = m.content.map((block: ContentBlock) => {
				if (block.type === "text") return { text: block.text };
				if (block.type === "tool_use") {
					return { functionCall: { name: block.name, args: block.input } };
				}
				return {
					functionResponse: {
						name: toolNames.get(block.tool_use_id) ?? block.tool_use_id,
						response: { output: block.content, is_error: block.is_error ?? false },
					},
				};
			});

			return { role, parts };
		});
}

export function createGeminiProvider(apiKey: string): Provider {
	const client = new GoogleGenAI({ apiKey });

	return {
		name: "gemini",

		async *complete(options: CompletionOptions): AsyncGenerator<StreamEvent> {
			// Gemini wants an empty tool list expressed as undefined, not [].
			const tools =
				options.tools.length > 0
					? [
							{
								functionDeclarations: options.tools.map((t) => ({
									name: t.name,
									description: t.description,
									parameters: t.input_schema,
								})),
							},
						]
					: undefined;

			const contents = toGeminiContents(options.messages);
			consola.debug(`gemini: ${options.model}, ${contents.length} turns, ${options.tools.length} tools`);

			const stream = await client.models.generateContentStream({
				model: options.model,
				contents,
				config: {
					systemInstruction: options.system,
					tools,
					maxOutputTokens: options.max_tokens,
					temperature: options.temperature,
					abortSignal: options.signal,
				},
			});

			let inputTokens = 0;
			let outputTokens = 0;

			for await (const chunk of stream) {
				if (chunk.usageMetadata) {
					inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
					outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
				}

				for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
					if (part.text) yield { type: "text_delta", delta: part.text };

					// Gemini sends one complete args object with no call id, so mint one
					// ourselves and emit start/delta/end together instead of streaming them.
					if (part.functionCall) {
						const id = crypto.randomUUID();
						yield { type: "tool_use_start", id, name: part.functionCall.name! };
						yield { type: "tool_use_input_delta", id, delta: JSON.stringify(part.functionCall.args ?? {}) };
						yield { type: "tool_use_end", id };
					}
				}
			}

			// Gemini always reports end_turn even when it called a tool, so the loop
			// figures out continuation from the tool_use events it already got.
			yield {
				type: "message_end",
				stop_reason: "end_turn",
				usage: { input_tokens: inputTokens, output_tokens: outputTokens },
			};
		},
	};
}

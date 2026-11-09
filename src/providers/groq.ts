// Groq provider, OpenAI-compatible chat completions with streaming.

import { consola } from "consola";
import Groq from "groq-sdk";
import type { ContentBlock } from "../types.js";
import type { CompletionOptions, Provider, StreamEvent } from "./types.js";

// Tool calls live on the assistant message; results come back as separate
// "tool" messages, one per tool_use_id.
function toGroqMessages(messages: CompletionOptions["messages"]) {
	const out: unknown[] = [];

	for (const m of messages) {
		if (m.role === "system") continue;

		if (typeof m.content === "string") {
			out.push({ role: m.role, content: m.content });
			continue;
		}

		const textParts = m.content
			.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("");

		if (m.role === "assistant") {
			const toolCalls = m.content
				.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
				.map((b) => ({
					id: b.id,
					type: "function" as const,
					function: { name: b.name, arguments: JSON.stringify(b.input) },
				}));

			out.push({
				role: "assistant",
				content: textParts || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}

		const toolResults = m.content.filter(
			(b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
		);
		if (toolResults.length > 0) {
			for (const b of toolResults)
				out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
			continue;
		}

		out.push({ role: "user", content: textParts });
	}

	return out;
}

export function createGroqProvider(apiKey: string): Provider {
	const client = new Groq({ apiKey });

	return {
		name: "groq",

		async *complete(options: CompletionOptions): AsyncGenerator<StreamEvent> {
			const messages = [{ role: "system", content: options.system }, ...toGroqMessages(options.messages)];

			const tools = options.tools.map((t) => ({
				type: "function" as const,
				function: { name: t.name, description: t.description, parameters: t.input_schema },
			}));

			consola.debug(`groq: ${options.model}, ${messages.length} messages, ${tools.length} tools`);

			const stream = await client.chat.completions.create(
				{
					model: options.model,
					// biome-ignore lint/suspicious/noExplicitAny: Groq's SDK types the union of message shapes narrower than the roles we build above
					messages: messages as any,
					tools: tools.length > 0 ? tools : undefined,
					stream: true,
					max_tokens: options.max_tokens,
					temperature: options.temperature,
				},
				{ signal: options.signal },
			);

			const toolCallAccumulator: Record<number, { id: string; name: string }> = {};
			let finishReason = "end_turn";
			let promptTokens = 0;
			let completionTokens = 0;

			try {
				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta;
					if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
					if (chunk.x_groq?.usage) {
						promptTokens = chunk.x_groq.usage.prompt_tokens ?? 0;
						completionTokens = chunk.x_groq.usage.completion_tokens ?? 0;
					}
					if (!delta) continue;

					if (delta.content) yield { type: "text_delta", delta: delta.content };

					for (const tc of delta.tool_calls ?? []) {
						const idx = tc.index;
						if (tc.id) {
							toolCallAccumulator[idx] = { id: tc.id, name: tc.function?.name ?? "" };
							yield { type: "tool_use_start", id: tc.id, name: tc.function?.name ?? "" };
						}
						if (tc.function?.arguments) {
							const id = toolCallAccumulator[idx]?.id;
							if (id) yield { type: "tool_use_input_delta", id, delta: tc.function.arguments };
						}
					}
				}
			} catch (err) {
				// Some Llama models on Groq serialize tool calls as raw <function=...>
				// text instead of proper tool_calls, which comes back as an HTTP 400
				// whose failed_generation field holds that markup, so parse it out by hand.
				const groqErr = err as { status?: number; error?: { failed_generation?: string } };
				const failedGen = groqErr.error?.failed_generation;
				if (groqErr.status === 400 && failedGen) {
					consola.warn("groq: tool_call serialization failed, parsing failed_generation");
					const regex = /<function=(\w+)\s+(.+?)<\/function>/gs;
					let match = regex.exec(failedGen);
					for (; match !== null; match = regex.exec(failedGen)) {
						const name = match[1]!;
						const argsStr = match[2]!;
						const idx = Object.keys(toolCallAccumulator).length;
						const id = `tc_${name}_${idx}`;
						try {
							JSON.parse(argsStr);
							toolCallAccumulator[idx] = { id, name };
							yield { type: "tool_use_start", id, name };
							yield { type: "tool_use_input_delta", id, delta: argsStr };
						} catch {
							consola.error(`groq: could not parse args for ${name}: ${argsStr}`);
						}
					}
					finishReason = "tool_calls";
				} else {
					throw err;
				}
			}

			for (const tc of Object.values(toolCallAccumulator)) yield { type: "tool_use_end", id: tc.id };

			yield {
				type: "message_end",
				stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
				usage: { input_tokens: promptTokens, output_tokens: completionTokens },
			};
		},
	};
}

import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ContentBlock, Message } from "../types.js";
import { httpError } from "./errors.js";
import type { CompletionOptions, Provider, StreamEvent } from "./types.js";

interface OllamaToolCall {
	id?: string;
	function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaChunk {
	message?: { content?: string; tool_calls?: OllamaToolCall[] };
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

export interface OllamaSettings {
	host: string;
	numCtx: number;
	numPredict?: number;
	seed?: number;
	temperature?: number;
}

export function ollamaSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaSettings {
	const host = env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
	return {
		host: host.startsWith("http") ? host : `http://${host}`,
		numCtx: Number(env.LEDGER_OLLAMA_NUM_CTX ?? 16384),
		numPredict:
			env.LEDGER_OLLAMA_NUM_PREDICT === undefined ? undefined : Number(env.LEDGER_OLLAMA_NUM_PREDICT),
		seed: env.LEDGER_SEED === undefined ? undefined : Number(env.LEDGER_SEED),
		temperature: env.LEDGER_TEMPERATURE === undefined ? undefined : Number(env.LEDGER_TEMPERATURE),
	};
}

function textOf(blocks: ContentBlock[]): string {
	return blocks
		.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("");
}

function toOllamaMessages(system: string, messages: Message[]): unknown[] {
	const out: unknown[] = [{ role: "system", content: system }];
	const toolNames = new Map<string, string>();

	for (const m of messages) {
		if (m.role === "system") continue;
		if (typeof m.content === "string") {
			out.push({ role: m.role, content: m.content });
			continue;
		}

		if (m.role === "assistant") {
			const calls = m.content.filter((b) => b.type === "tool_use");
			for (const c of calls) toolNames.set(c.id, c.name);
			out.push({
				role: "assistant",
				content: textOf(m.content),
				...(calls.length > 0
					? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) }
					: {}),
			});
			continue;
		}

		const results = m.content.filter((b) => b.type === "tool_result");
		for (const r of results) {
			out.push({ role: "tool", tool_name: toolNames.get(r.tool_use_id), content: r.content });
		}
		const text = textOf(m.content);
		if (text || results.length === 0) out.push({ role: "user", content: text });
	}
	return out;
}

export function createOllamaProvider(settings: OllamaSettings = ollamaSettingsFromEnv()): Provider {
	return {
		name: "ollama",

		async *complete(options: CompletionOptions): AsyncGenerator<StreamEvent> {
			const res = await fetch(`${settings.host}/api/chat`, {
				method: "POST",
				signal: options.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: options.model,
					stream: true,
					messages: toOllamaMessages(options.system, options.messages),
					tools: options.tools.map((t) => ({
						type: "function",
						function: { name: t.name, description: t.description, parameters: t.input_schema },
					})),
					options: {
						num_ctx: settings.numCtx,
						num_predict: Math.min(options.max_tokens, settings.numPredict ?? options.max_tokens),
						...((options.temperature ?? settings.temperature) === undefined
							? {}
							: { temperature: options.temperature ?? settings.temperature }),
						...(settings.seed === undefined ? {} : { seed: settings.seed }),
					},
				}),
			});
			if (!res.ok || !res.body) throw httpError(res.status, await res.text());

			let callIndex = 0;
			let sawToolCall = false;
			const lines = createInterface({ input: Readable.fromWeb(res.body as never) });

			for await (const line of lines) {
				if (!line.trim()) continue;
				const chunk = JSON.parse(line) as OllamaChunk;
				if (chunk.error) throw new Error(`ollama: ${chunk.error}`);

				if (chunk.message?.content) yield { type: "text_delta", delta: chunk.message.content };

				for (const call of chunk.message?.tool_calls ?? []) {
					const id = call.id ?? `ollama_${callIndex}`;
					callIndex++;
					sawToolCall = true;
					const args =
						typeof call.function.arguments === "string"
							? call.function.arguments
							: JSON.stringify(call.function.arguments ?? {});
					yield { type: "tool_use_start", id, name: call.function.name };
					yield { type: "tool_use_input_delta", id, delta: args };
					yield { type: "tool_use_end", id };
				}

				if (chunk.done) {
					yield {
						type: "message_end",
						stop_reason: sawToolCall
							? "tool_use"
							: chunk.done_reason === "length"
								? "max_tokens"
								: "end_turn",
						usage: { input_tokens: chunk.prompt_eval_count ?? 0, output_tokens: chunk.eval_count ?? 0 },
					};
				}
			}
		},
	};
}

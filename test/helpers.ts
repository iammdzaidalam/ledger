import type { CompletionOptions, Provider, StreamEvent } from "../src/providers/types.js";
import type { Message } from "../src/types.js";

export type Call = { name: string; input: Record<string, unknown> };
export type Step = { text?: string; calls?: Call[] };

export function scriptedProvider(steps: Step[], seen: Message[][] = []): Provider {
	let i = 0;
	return {
		name: "scripted",
		async *complete(options: CompletionOptions): AsyncGenerator<StreamEvent> {
			seen.push(structuredClone(options.messages));
			const step = steps[i++] ?? {};
			if (step.text) yield { type: "text_delta", delta: step.text };
			for (const [n, call] of (step.calls ?? []).entries()) {
				const id = `call_${i}_${n}`;
				yield { type: "tool_use_start", id, name: call.name };
				yield { type: "tool_use_input_delta", id, delta: JSON.stringify(call.input) };
				yield { type: "tool_use_end", id };
			}
			yield {
				type: "message_end",
				stop_reason: step.calls?.length ? "tool_use" : "end_turn",
				usage: { input_tokens: 0, output_tokens: 0 },
			};
		},
	};
}

export function orphanedToolResults(messages: Message[]): string[] {
	const orphans: string[] = [];
	for (const [i, m] of messages.entries()) {
		if (typeof m.content === "string") continue;
		for (const block of m.content) {
			if (block.type !== "tool_result") continue;
			const prev = messages[i - 1];
			const paired =
				prev?.role === "assistant" &&
				Array.isArray(prev.content) &&
				prev.content.some((b) => b.type === "tool_use" && b.id === block.tool_use_id);
			if (!paired) orphans.push(block.tool_use_id);
		}
	}
	return orphans;
}

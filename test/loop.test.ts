import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import type { AgentEvent } from "../src/agent/types.js";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import type { CompletionOptions, Provider, StreamEvent } from "../src/providers/types.js";
import type { Message } from "../src/types.js";

type Step = { text?: string; bash?: string };

function scripted(steps: Step[], seen: Message[][]): Provider {
	let i = 0;
	return {
		name: "scripted",
		async *complete(options: CompletionOptions): AsyncGenerator<StreamEvent> {
			seen.push(structuredClone(options.messages));
			const step = steps[i++] ?? {};
			if (step.text) yield { type: "text_delta", delta: step.text };
			if (step.bash) {
				const id = `call_${i}`;
				yield { type: "tool_use_start", id, name: "Bash" };
				yield { type: "tool_use_input_delta", id, delta: JSON.stringify({ command: step.bash }) };
				yield { type: "tool_use_end", id };
			}
			yield {
				type: "message_end",
				stop_reason: step.bash ? "tool_use" : "end_turn",
				usage: { input_tokens: 0, output_tokens: 0 },
			};
		},
	};
}

async function collect(steps: Step[], extra: { feedback?: boolean; claimsMode?: "prose" | "tagged" } = {}) {
	const seen: Message[][] = [];
	const events: AgentEvent[] = [];
	for await (const e of runAgent({
		providerName: "scripted",
		model: "scripted",
		system: "",
		messages: [{ role: "user", content: "run the tests" }],
		groundingClient: client,
		evidence: new EvidenceLog(),
		provider: scripted(steps, seen),
		...extra,
	})) {
		events.push(e);
	}
	return { events, seen };
}

let client: GroundingClient;

afterEach(() => client?.close());

describe("runAgent grounding", () => {
	it("flags a success claim made after a failing command", async () => {
		client = new GroundingClient();
		const { events } = await collect([
			{ bash: "echo '      Tests  1 failed | 2 passed (3)'; exit 1" },
			{ text: "All tests pass." },
		]);
		const flags = events.filter((e) => e.type === "grounding_flag");
		expect(flags).toHaveLength(1);
		expect(flags[0]).toMatchObject({ claim: { kind: "tests_pass", verdict: "contradicted", ref: "c1" } });
	});

	it("checks a claim made before any tool ran", async () => {
		client = new GroundingClient();
		const { events } = await collect([{ text: "I ran the tests and they all pass." }]);
		expect(events.find((e) => e.type === "grounding_flag")).toMatchObject({
			claim: { verdict: "unsupported" },
		});
	});

	it("sends flags back to the model with --feedback, once", async () => {
		client = new GroundingClient();
		const { seen } = await collect(
			[
				{ bash: "exit 1" },
				{ text: "Done, all good." },
				{ text: "Sorry, it failed with exit 1." },
				{ text: "unused" },
			],
			{ feedback: true },
		);
		expect(seen).toHaveLength(3);
		const last = seen[2]?.at(-1);
		expect(last?.role).toBe("user");
		expect(String(last?.content)).toContain("do not hold up");
	});

	it("prefixes tool results with refs in tagged mode", async () => {
		client = new GroundingClient();
		const { seen, events } = await collect(
			[{ bash: "exit 1" }, { text: '<claim ref="c1">the command succeeded</claim>' }],
			{
				claimsMode: "tagged",
			},
		);
		const toolResult = seen[1]?.at(-1)?.content;
		expect(
			Array.isArray(toolResult) && toolResult[0]?.type === "tool_result" && toolResult[0].content,
		).toMatch(/^\[ref c1\]/);
		expect(events.find((e) => e.type === "grounding_flag")).toMatchObject({
			claim: { attribution: "tag", verdict: "contradicted" },
		});
	});
});

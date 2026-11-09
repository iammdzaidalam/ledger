import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	autoCompact,
	compactHistory,
	estimateTokens,
	findSplit,
	withSummary,
} from "../src/agent/compaction.js";
import { runAgent } from "../src/agent/loop.js";
import type { AgentEvent, AgentOptions } from "../src/agent/types.js";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import type { ContentBlock, Message } from "../src/types.js";
import { orphanedToolResults, type Step, scriptedProvider } from "./helpers.js";

function randomHistory(seed: number): Message[] {
	let state = seed;
	const next = (n: number) => {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		return state % n;
	};
	const messages: Message[] = [];
	let id = 0;
	for (let turn = 0; turn < 2 + next(4); turn++) {
		messages.push({ role: "user", content: `request ${turn}` });
		for (let round = 0; round < next(4); round++) {
			const calls: ContentBlock[] = Array.from({ length: 1 + next(3) }, () => ({
				type: "tool_use",
				id: `t${id++}`,
				name: "Bash",
				input: { command: "ls" },
			}));
			messages.push({ role: "assistant", content: [{ type: "text", text: "working" }, ...calls] });
			messages.push({
				role: "user",
				content: calls.map((c) => ({
					type: "tool_result" as const,
					tool_use_id: c.type === "tool_use" ? c.id : "",
					content: "out",
				})),
			});
		}
		messages.push({ role: "assistant", content: [{ type: "text", text: "done with that" }] });
	}
	return messages;
}

describe("splitting history for compaction", () => {
	it("never leaves a tool_result without its tool_use, for any history and keep size", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const history = randomHistory(seed);
			for (let keep = 1; keep <= 9; keep++) {
				const split = findSplit(history, keep);
				if (split === 0) continue;
				const compacted = withSummary("summary", history.slice(split));
				expect(orphanedToolResults(compacted)).toEqual([]);
				expect(compacted[0]?.role).toBe("user");
			}
		}
	});

	it("merges the summary into a leading user message, or adds one before an assistant message", () => {
		const merged = withSummary("S", [{ role: "user", content: "next question" }]);
		expect(merged).toHaveLength(1);
		expect(String(merged[0]?.content)).toMatch(/S\n\nnext question$/);

		const prepended = withSummary("S", [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
		expect(prepended.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("counts tool inputs, not just text, when estimating size", () => {
		const big: Message = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "w", name: "Write", input: { path: "a", content: "x".repeat(4000) } },
			],
		};
		expect(estimateTokens([big])).toBeGreaterThan(1000);
	});

	it("falls back to a plain list when the summarizer fails", async () => {
		const history: Message[] = [
			{ role: "user", content: "request 0" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "Exit 1", is_error: true }],
			},
			{ role: "assistant", content: [{ type: "text", text: "It failed." }] },
			{ role: "user", content: "request 1" },
		];
		const result = await compactHistory(
			history,
			async () => {
				throw new Error("rate limited");
			},
			2,
		);
		expect(result?.usedFallback).toBe(true);
		expect(result?.summary).toContain("request 0");
		expect(result?.summary).toContain('Bash {"command":"npm test"} (failed)');
		expect(result?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("leaves short histories alone", async () => {
		const ctx = { provider: scriptedProvider([]), model: "m", system: "", tools: [] };
		const history: Message[] = [{ role: "user", content: "hi" }];
		expect(await autoCompact(history, ctx, { contextLimit: 100_000 })).toBeNull();
		expect(await compactHistory(history, async () => "s", 6)).toBeNull();
	});
});

describe("compaction in the agent loop", () => {
	let client: GroundingClient;

	beforeAll(() => {
		client = new GroundingClient();
	});

	afterAll(() => client.close());

	async function run(
		messages: Message[],
		steps: Step[],
		evidence: EvidenceLog,
		extra: Partial<AgentOptions> = {},
	) {
		const seen: Message[][] = [];
		const events: AgentEvent[] = [];
		let final: Message[] = [];
		for await (const e of runAgent({
			providerName: "scripted",
			model: "scripted",
			system: "",
			messages,
			groundingClient: client,
			evidence,
			provider: scriptedProvider(steps, seen),
			...extra,
		})) {
			events.push(e);
			if (e.type === "agent_end") final = e.messages;
		}
		return { seen, events, final };
	}

	it("checks 'I already ran the tests' against the real record after the run was compacted away", async () => {
		const evidence = new EvidenceLog();
		const first = await run(
			[{ role: "user", content: "run the tests" }],
			[
				{
					calls: [
						{ name: "Bash", input: { command: "echo '      Tests  1 failed | 2 passed (3)'; exit 1" } },
					],
				},
				{ text: "One test failed." },
			],
			evidence,
		);

		const summaries: string[] = [];
		const second = await run(
			[...first.final, { role: "user", content: "are we good to ship?" }],
			[{ text: "Yes. I already ran the tests and they all pass." }],
			evidence,
			{
				compaction: {
					contextLimit: 1,
					keepRecent: 1,
					summarize: async (transcript) => {
						summaries.push(transcript);
						return "The user asked to run the tests and the agent ran them.";
					},
				},
			},
		);

		const compaction = second.events.find((e) => e.type === "compaction");
		expect(compaction).toBeDefined();
		const sent = second.seen[0] ?? [];
		expect(JSON.stringify(sent)).not.toContain("tool_result");
		expect(JSON.stringify(sent)).not.toContain("exit 1");
		expect(summaries[0]).toContain("[called Bash");

		expect(evidence.all()).toHaveLength(1);
		expect(evidence.all()[0]).toMatchObject({ ref: "c1", exit_code: 1 });

		expect(second.events.find((e) => e.type === "grounding_flag")).toMatchObject({
			claim: { kind: "tests_pass", verdict: "contradicted", ref: "c1" },
		});
	});

	it("compacts mid-run without ever sending an orphaned tool_result", async () => {
		const evidence = new EvidenceLog();
		const { seen, events } = await run(
			[{ role: "user", content: "look around" }],
			[
				{ calls: [{ name: "Bash", input: { command: "echo one" } }] },
				{
					calls: [
						{ name: "Bash", input: { command: "echo two" } },
						{ name: "Bash", input: { command: "echo three" } },
					],
				},
				{ calls: [{ name: "Bash", input: { command: "echo four" } }] },
				{ text: "Looked around." },
			],
			evidence,
			{ compaction: { contextLimit: 5, keepRecent: 2, summarize: async () => "earlier work" } },
		);
		expect(events.filter((e) => e.type === "compaction").length).toBeGreaterThan(0);
		for (const messages of seen) {
			expect(orphanedToolResults(messages)).toEqual([]);
			expect(messages[0]?.role).toBe("user");
		}
		expect(evidence.all().map((e) => e.ref)).toEqual(["c1", "c2", "c3", "c4"]);
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import type { AgentEvent, AgentOptions } from "../src/agent/types.js";
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

type Extra = Pick<
	AgentOptions,
	"feedback" | "claimsMode" | "validate" | "maxRevisions" | "maxRevisionsPerRun"
>;

async function collect(steps: Step[], extra: Partial<Extra> = {}) {
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

const FAIL = "echo '      Tests  1 failed | 2 passed (3)'; exit 1";
const PASS = "echo '      Tests  3 passed (3)'";

function pick<T extends AgentEvent["type"]>(events: AgentEvent[], type: T) {
	return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

function ledgerOf(events: AgentEvent[]) {
	return pick(events, "agent_end")[0]?.ledger;
}

describe("runAgent revision loop", () => {
	it("sends focused feedback for a lie and accepts the corrected revision", async () => {
		client = new GroundingClient();
		const { events, seen } = await collect(
			[{ bash: FAIL }, { text: "All tests pass." }, { bash: PASS }, { text: "All tests pass now." }],
			{ validate: "revise" },
		);

		const [request] = pick(events, "grounding_revision_requested");
		expect(request).toMatchObject({ turn: 2, round: 1, maxRevisions: 1 });
		const feedback = String(seen[2]?.at(-1)?.content);
		expect(feedback).toContain('"All tests pass."');
		expect(feedback).toContain("contradicted by c1");
		expect(feedback).toContain("1 failed");
		expect(feedback).toContain("rerun the tests");

		const results = pick(events, "grounding_revision_result");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			turn: 4,
			originTurn: 2,
			next: "accepted",
			outcomes: [{ outcome: "corrected", how: "verified", revised: { ref: "c2", verdict: "verified" } }],
		});
		expect(ledgerOf(events)).toMatchObject({
			unverified: false,
			revisionsRequested: 1,
			entries: [{ status: "corrected", correctedBy: "verified", firstVerdict: "contradicted", revisions: 1 }],
		});
	});

	it("counts a revision that drops the claim as a retraction", async () => {
		client = new GroundingClient();
		const { events } = await collect(
			[{ bash: FAIL }, { text: "All tests pass." }, { text: "Sorry, one test is still failing." }],
			{ validate: "revise" },
		);
		expect(pick(events, "grounding_revision_result")[0]).toMatchObject({
			next: "accepted",
			outcomes: [{ outcome: "corrected", how: "retracted" }],
		});
		expect(ledgerOf(events)?.entries[0]).toMatchObject({ status: "corrected", correctedBy: "retracted" });
	});

	it("stops after the revision budget when the model lies twice", async () => {
		client = new GroundingClient();
		const { events, seen } = await collect(
			[{ bash: FAIL }, { text: "All tests pass." }, { text: "All tests pass." }, { text: "unused" }],
			{ validate: "revise" },
		);
		expect(seen).toHaveLength(3);
		expect(pick(events, "grounding_revision_requested")).toHaveLength(1);
		expect(pick(events, "grounding_revision_result")[0]).toMatchObject({
			next: "exhausted",
			outcomes: [{ outcome: "still_false", revised: { verdict: "contradicted" } }],
		});
		expect(ledgerOf(events)).toMatchObject({
			unverified: true,
			falseClaims: 1,
			entries: [{ status: "false", verdict: "contradicted", revisions: 1 }],
		});
	});

	it("feeds back a new false claim introduced by the revision", async () => {
		client = new GroundingClient();
		const { events, seen } = await collect(
			[
				{ bash: FAIL },
				{ text: "All tests pass." },
				{ text: "Sorry, one test is still failing. I created notes.txt with the details." },
				{ text: "I did not write notes.txt after all." },
			],
			{ validate: "revise", maxRevisions: 2 },
		);
		const results = pick(events, "grounding_revision_result");
		expect(results.map((r) => r.next)).toEqual(["revise", "accepted"]);
		expect(results[0]?.outcomes).toMatchObject([
			{ outcome: "corrected", how: "retracted", claim: { kind: "tests_pass" } },
			{ outcome: "new_false", claim: { kind: "file_created", verdict: "unsupported" } },
		]);
		const second = String(seen[3]?.at(-1)?.content);
		expect(second).toContain("revision 2 of 2");
		expect(second).toContain("notes.txt");
		expect(second).not.toContain("All tests pass");
		expect(ledgerOf(events)?.entries).toMatchObject([
			{ kind: "tests_pass", status: "corrected" },
			{ kind: "file_created", status: "corrected", newInRevision: true },
		]);
	});

	it("gives each flagged turn its own budget, capped per run", async () => {
		client = new GroundingClient();
		const lie = { text: "Done, it worked.", bash: "exit 1" };
		const { events, seen } = await collect(
			[{ bash: "exit 1" }, lie, lie, lie, lie, { text: "Done, it worked." }, { text: "unused" }],
			{ validate: "revise", maxRevisions: 1, maxRevisionsPerRun: 2 },
		);
		expect(seen).toHaveLength(6);
		expect(pick(events, "grounding_revision_requested").map((r) => r.originTurn)).toEqual([2, 4]);
		expect(pick(events, "grounding_revision_result").map((r) => r.next)).toEqual(["exhausted", "exhausted"]);
		const ledger = ledgerOf(events);
		expect(ledger?.revisionsRequested).toBe(2);
		expect(ledger?.entries.map((e) => [e.turn, e.status, e.revisions])).toEqual([
			[2, "false", 1],
			[4, "false", 1],
			[6, "false", 0],
		]);
	});

	it("only shows flags in flag mode and skips the checker when off", async () => {
		client = new GroundingClient();
		const flagged = await collect([{ bash: FAIL }, { text: "All tests pass." }, { text: "unused" }]);
		expect(flagged.seen).toHaveLength(2);
		expect(pick(flagged.events, "grounding_revision_requested")).toHaveLength(0);
		expect(ledgerOf(flagged.events)).toMatchObject({ mode: "flag", falseClaims: 1 });

		const off = await collect([{ bash: FAIL }, { text: "All tests pass." }], { validate: "off" });
		expect(pick(off.events, "grounding_check")).toHaveLength(0);
		expect(ledgerOf(off.events)?.entries).toEqual([]);
	});
});

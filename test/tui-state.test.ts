import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/types.js";
import type { ClaimResult, Evidence } from "../src/grounding/types.js";
import type { RunLedger } from "../src/grounding/validation.js";
import {
	type AssistantEntry,
	initialState,
	reduce,
	type TuiAction,
	type TuiState,
	tally,
} from "../src/tui/state.js";

const session = { id: "s1", provider: "ollama", model: "qwen2.5:7b" };

function claim(text: string, verdict: ClaimResult["verdict"], ref?: string): ClaimResult {
	return {
		text,
		kind: "tests_pass",
		verdict,
		ref,
		attribution: "family",
		rule: "r",
		reason: `${ref} said so`,
	};
}

function evidence(ref: string, exit: number): Evidence {
	return {
		ref,
		seq: Number(ref.slice(1)),
		tool: "Bash",
		args: { command: "npm test" },
		raw_stdout: "",
		raw_stderr: "",
		exit_code: exit,
		executed: true,
		is_error: exit !== 0,
		duration_ms: 1200,
	};
}

function apply(state: TuiState, events: AgentEvent[]): TuiState {
	return events.reduce((s, event) => reduce(s, { type: "agent", event }), state);
}

function play(events: AgentEvent[], start: TuiState = initialState({ session })): TuiState {
	return apply(reduce(start, { type: "submit", text: "run the tests" }), events);
}

function assistants(state: TuiState): AssistantEntry[] {
	return state.entries.filter((e): e is AssistantEntry => e.kind === "assistant");
}

describe("tui reducer", () => {
	it("streams text into one assistant entry and closes it on assistant_turn", () => {
		const state = play([
			{ type: "agent_start" },
			{ type: "text_delta", delta: "All " },
			{ type: "text_delta", delta: "tests pass. " },
		]);
		expect(state.running).toBe(true);
		expect(assistants(state)).toMatchObject([{ text: "All tests pass. ", streaming: true }]);

		const done = reduce(state, {
			type: "agent",
			event: { type: "assistant_turn", turn: 1, text: "All tests pass.", toolCalls: 0 },
		});
		expect(assistants(done)).toMatchObject([{ text: "All tests pass.", streaming: false, turn: 1 }]);
	});

	it("tracks a tool call from start to evidence to end", () => {
		const state = play([
			{ type: "text_delta", delta: "Running them." },
			{ type: "assistant_turn", turn: 1, text: "Running them.", toolCalls: 1 },
			{ type: "tool_start", id: "t1", name: "Bash", input: { command: "npm test" } },
		]);
		const tool = state.entries.at(-1);
		expect(tool).toMatchObject({ kind: "tool", status: "running", summary: "npm test" });

		const after = apply(state, [
			{ type: "evidence", entry: evidence("c1", 1) },
			{ type: "tool_end", id: "t1", name: "Bash", result: "1 failed", isError: true },
		]);
		expect(after.evidence.map((e) => e.ref)).toEqual(["c1"]);
		expect(after.entries.find((e) => e.kind === "tool")).toMatchObject({
			status: "failed",
			ref: "c1",
			outcome: "exit 1",
			seconds: 1.2,
		});
	});

	it("attaches checked claims to the assistant turn they came from", () => {
		const bad = claim("All tests pass.", "contradicted", "c1");
		const good = claim("Lint is clean.", "verified", "c2");
		const state = play([
			{ type: "text_delta", delta: "First turn." },
			{ type: "assistant_turn", turn: 1, text: "First turn.", toolCalls: 1 },
			{ type: "tool_start", id: "t1", name: "Bash", input: { command: "npm test" } },
			{ type: "tool_end", id: "t1", name: "Bash", result: "", isError: false },
			{ type: "text_delta", delta: "All tests pass. Lint is clean." },
			{ type: "assistant_turn", turn: 2, text: "All tests pass. Lint is clean.", toolCalls: 0 },
			{ type: "grounding_check", turn: 2, claims: [bad, good], latencyMs: 3 },
			{ type: "grounding_flag", claim: bad },
		]);
		const [first, second] = assistants(state);
		expect(first?.claims).toEqual([]);
		expect(second?.claims).toEqual([bad, good]);
		expect(state.claims.map((c) => [c.turn, c.claim.verdict])).toEqual([
			[2, "contradicted"],
			[2, "verified"],
		]);
		expect(tally(state.claims)).toEqual({ verified: 1, corrected: 0, false: 1, unverifiable: 0 });
	});

	it("records revision requests and marks the outcome on the original claim", () => {
		const bad = claim("All tests pass.", "contradicted", "c1");
		const state = play([
			{ type: "text_delta", delta: "All tests pass." },
			{ type: "assistant_turn", turn: 1, text: "All tests pass.", toolCalls: 0 },
			{ type: "grounding_check", turn: 1, claims: [bad], latencyMs: 1 },
			{
				type: "grounding_revision_requested",
				turn: 1,
				originTurn: 1,
				round: 1,
				maxRevisions: 1,
				claims: [bad],
				feedback: "fix it",
			},
			{ type: "text_delta", delta: "Sorry, one test fails." },
			{ type: "assistant_turn", turn: 2, text: "Sorry, one test fails.", toolCalls: 0 },
			{ type: "grounding_check", turn: 2, claims: [], latencyMs: 1 },
			{
				type: "grounding_revision_result",
				turn: 2,
				originTurn: 1,
				round: 1,
				outcomes: [{ outcome: "corrected", claim: bad, how: "retracted" }],
				next: "accepted",
			},
		]);
		const kinds = state.entries.map((e) => e.kind);
		expect(kinds).toEqual(["user", "assistant", "revision_request", "assistant", "revision_result"]);
		expect(assistants(state)[0]?.outcomes).toEqual({ 0: "corrected" });
		expect(state.claims[0]?.outcome).toBe("corrected");
		expect(tally(state.claims)).toMatchObject({ corrected: 1, false: 0 });
	});

	it("adds the ledger table at the end of a run, plus the strict marker when unverified", () => {
		const ledger: RunLedger = {
			mode: "strict",
			entries: [
				{
					turn: 1,
					text: "All tests pass.",
					kind: "tests_pass",
					ref: "c1",
					firstVerdict: "contradicted",
					verdict: "contradicted",
					reason: "exit 1",
					status: "false",
					revisions: 1,
					newInRevision: false,
				},
			],
			revisionsRequested: 1,
			falseClaims: 1,
			checkerErrors: 0,
			unverified: true,
		};
		const start = initialState({ session, validate: "strict" });
		const state = play([{ type: "agent_end", messages: [], ledger }], start);
		expect(state.entries.map((e) => e.kind)).toEqual(["user", "ledger", "notice"]);
		expect(state.entries.at(-1)).toMatchObject({
			tone: "error",
			text: expect.stringContaining("[UNVERIFIED]"),
		});
		const finished = reduce(state, { type: "run_finished" });
		expect(finished.running).toBe(false);
	});

	it("skips the ledger when no claims were checked", () => {
		const ledger: RunLedger = {
			mode: "flag",
			entries: [],
			revisionsRequested: 0,
			falseClaims: 0,
			checkerErrors: 0,
			unverified: false,
		};
		const state = play([{ type: "agent_end", messages: [], ledger }]);
		expect(state.entries.map((e) => e.kind)).toEqual(["user"]);
	});

	it("marks running tools as cancelled and shows provider errors as one notice", () => {
		const state = play([{ type: "tool_start", id: "t1", name: "Bash", input: { command: "sleep 100" } }]);
		const cancelled = reduce(state, { type: "run_finished", cancelled: true });
		expect(cancelled.entries.find((e) => e.kind === "tool")).toMatchObject({ status: "cancelled" });
		expect(cancelled.entries.at(-1)).toMatchObject({ kind: "notice", text: "Cancelled." });

		const failed = reduce(play([]), {
			type: "run_finished",
			error: "Could not reach Ollama at http://127.0.0.1:11434. Is it running?",
		});
		expect(failed.running).toBe(false);
		expect(failed.entries.at(-1)).toMatchObject({ kind: "notice", tone: "error" });
	});

	it("drops an assistant entry that only streamed whitespace", () => {
		const state = play([
			{ type: "text_delta", delta: "\n" },
			{ type: "assistant_turn", turn: 1, text: "", toolCalls: 1 },
		]);
		expect(assistants(state)).toEqual([]);
	});

	it("replaces evidence and claims when a different session is loaded", () => {
		const state = play([{ type: "evidence", entry: evidence("c1", 0) }]);
		const action: TuiAction = {
			type: "sync",
			session: { ...session, id: "s2" },
			evidence: [evidence("c1", 1), evidence("c2", 0)],
			claims: [{ timestamp: "t", claims: [claim("Done.", "unverifiable")] }],
		};
		const next = reduce(state, action);
		expect(next.session.id).toBe("s2");
		expect(next.evidence.map((e) => e.ref)).toEqual(["c1", "c2"]);
		expect(next.claims).toHaveLength(1);
		expect(next.claims[0]).toMatchObject({ turn: 0, claim: { verdict: "unverifiable" } });
	});

	it("does not mutate the previous state", () => {
		const before = play([{ type: "text_delta", delta: "Hi" }]);
		const snapshot = structuredClone(before);
		reduce(before, { type: "agent", event: { type: "text_delta", delta: " there" } });
		expect(before).toEqual(snapshot);
	});
});

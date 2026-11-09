import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import type { AgentEvent } from "../src/agent/types.js";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import { runTurn } from "../src/modes/turn.js";
import { ActiveSession, CANCELLED_NOTE } from "../src/session/active.js";
import { loadSession } from "../src/session/store.js";
import { runProcess } from "../src/tools/process.js";
import type { Message } from "../src/types.js";
import { scriptedProvider } from "./helpers.js";

let client: GroundingClient;
afterEach(() => client?.close());

describe("runProcess cancellation", () => {
	it("kills the child when the signal aborts and reports it as cancelled", async () => {
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 100);
		const out = await runProcess("sleep", ["5"], { timeoutMs: 10_000, signal: controller.signal });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out).toMatchObject({ cancelled: true, timedOut: false, exitCode: null, executed: true });
	});

	it("does not start a process when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const out = await runProcess("sleep", ["5"], { timeoutMs: 10_000, signal: controller.signal });
		expect(out).toMatchObject({ cancelled: true, executed: false });
	});
});

describe("agent loop cancellation", () => {
	it("stops a running Bash call, records it as unfinished, and makes no further model calls", async () => {
		client = new GroundingClient();
		const controller = new AbortController();
		const seen: Message[][] = [];
		const provider = scriptedProvider(
			[{ calls: [{ name: "Bash", input: { command: "sleep 5" } }] }, { text: "The sleep finished fine." }],
			seen,
		);
		const events: AgentEvent[] = [];
		const started = Date.now();
		setTimeout(() => controller.abort(), 150);
		for await (const e of runAgent({
			providerName: "scripted",
			model: "scripted",
			system: "",
			messages: [{ role: "user", content: "sleep" }],
			groundingClient: client,
			evidence: new EvidenceLog(),
			provider,
			signal: controller.signal,
		})) {
			events.push(e);
		}
		expect(Date.now() - started).toBeLessThan(2000);
		expect(seen).toHaveLength(1);
		const evidence = events.find((e) => e.type === "evidence");
		expect(evidence).toMatchObject({
			type: "evidence",
			toolUseId: "call_1_0",
			entry: { ref: "c1", exit_code: null, executed: true },
		});
		if (evidence?.type === "evidence") expect(evidence.entry.raw_stderr).toContain("cancelled by the user");
		expect(events.at(-1)?.type).toBe("agent_end");
	});
});

describe("cancelling a turn in a session", () => {
	it("closes the turn with an assistant note so the next turn does not send two user messages in a row", async () => {
		client = new GroundingClient();
		const cwd = mkdtempSync(join(tmpdir(), "ledger-cancel-"));
		const session = ActiveSession.create("cancelled", "scripted", "scripted", cwd);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		await runTurn(
			session,
			"sleep",
			{
				system: "",
				autoCompact: false,
				provider: scriptedProvider([{ calls: [{ name: "Bash", input: { command: "sleep 5" } }] }]),
			},
			client,
			() => undefined,
			controller.signal,
		);
		expect(session.history.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(session.history.at(-1)?.content).toEqual([{ type: "text", text: CANCELLED_NOTE }]);
		const saved = await loadSession("cancelled", cwd);
		expect(saved?.messages).toEqual(session.history);
		expect(saved?.evidence[0]).toMatchObject({ ref: "c1", exit_code: null });
	});
});

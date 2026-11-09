import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/types.js";
import { BUILTIN_COMMANDS } from "../src/commands/builtin.js";
import { type ReplState, runCommandLine } from "../src/commands/registry.js";
import { GroundingClient } from "../src/grounding/client.js";
import { runTurn } from "../src/modes/turn.js";
import { ActiveSession } from "../src/session/active.js";
import {
	latestSessionId,
	listSessions,
	loadSession,
	resolveSessionId,
	sessionPath,
} from "../src/session/store.js";
import { type Step, scriptedProvider } from "./helpers.js";

const FAILING_TESTS = "echo '      Tests  1 failed | 2 passed (3)'; exit 1";

describe("sessions", () => {
	let cwd: string;
	let client: GroundingClient;

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "ledger-sessions-"));
		client = new GroundingClient();
	});

	afterAll(async () => {
		client.close();
		await rm(cwd, { recursive: true, force: true });
	});

	async function turn(session: ActiveSession, input: string, steps: Step[], contextLimit?: number) {
		const events: AgentEvent[] = [];
		await runTurn(
			session,
			input,
			{
				system: "",
				provider: scriptedProvider(steps),
				contextLimit,
			},
			client,
			(e) => events.push(e),
		);
		return events;
	}

	it("saves messages, evidence and claims, and resumes with the evidence log intact", async () => {
		const session = ActiveSession.create("first", "scripted", "scripted", cwd);
		await turn(session, "run the tests", [
			{ calls: [{ name: "Bash", input: { command: FAILING_TESTS } }] },
			{ text: "One test failed." },
		]);

		const data = await loadSession("first", cwd);
		expect(data).toMatchObject({ provider: "scripted", model: "scripted", messageCount: 4 });
		expect(data?.messages).toEqual(session.history);
		expect(data?.evidence).toHaveLength(1);
		expect(data?.evidence[0]).toMatchObject({ ref: "c1", exit_code: 1 });

		if (!data) throw new Error("session not saved");
		const resumed = ActiveSession.fromData(data, "scripted", "scripted");
		expect(resumed.evidence.all()).toEqual(session.evidence.all());

		const events = await turn(resumed, "so are we green?", [
			{ calls: [{ name: "Bash", input: { command: "echo hi" } }] },
			{ text: "I already ran the tests earlier and they all pass." },
		]);
		const evidenceRefs = events.flatMap((e) => (e.type === "evidence" ? [e.entry.ref] : []));
		expect(evidenceRefs).toEqual(["c2"]);
		expect(events.find((e) => e.type === "grounding_flag")).toMatchObject({
			claim: { kind: "tests_pass", verdict: "contradicted", ref: "c1" },
		});

		const reloaded = await loadSession("first", cwd);
		expect(reloaded?.messages).toEqual(resumed.history);
		expect(reloaded?.evidence.map((e) => e.ref)).toEqual(["c1", "c2"]);
		expect(reloaded?.claims.flatMap((r) => r.claims).some((c) => c.verdict === "contradicted")).toBe(true);
	});

	it("replays a compaction the same way it happened in memory", async () => {
		const session = ActiveSession.create("compacted", "scripted", "scripted", cwd);
		await turn(session, "step one", [
			{ calls: [{ name: "Bash", input: { command: "echo a" } }] },
			{ text: "a done" },
		]);
		const events = await turn(
			session,
			"step two",
			[{ calls: [{ name: "Bash", input: { command: "echo b" } }] }, { text: "b done" }],
			1,
		);
		expect(events.some((e) => e.type === "compaction")).toBe(true);

		const data = await loadSession("compacted", cwd);
		expect(data?.messages).toEqual(session.history);
		expect(data?.evidence).toHaveLength(2);
		expect(data?.messages[0]?.content).toMatch(/^Summary of the earlier conversation/);
		expect(data?.messageCount).toBe(8);
	});

	it("reads old message-only sessions and skips a torn last line", async () => {
		const path = sessionPath("legacy", cwd);
		await mkdir(join(cwd, ".ledger", "sessions"), { recursive: true });
		const line = (content: string) =>
			JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content } });
		await writeFile(path, `${line("hello")}\n${line("again")}\n`);
		await appendFile(path, '{"type":"message","timest');
		const data = await loadSession("legacy", cwd);
		expect(data?.messages.map((m) => m.content)).toEqual(["hello", "again"]);
	});

	it("lists sessions newest first and resolves id prefixes", async () => {
		const old = new Date("2026-01-01T00:00:00Z");
		await utimes(sessionPath("legacy", cwd), old, old);
		const sessions = await listSessions(cwd);
		expect(sessions.map((s) => s.id)).toContain("first");
		expect(sessions.at(-1)?.id).toBe("legacy");
		expect(sessions.find((s) => s.id === "first")).toMatchObject({
			evidence: 2,
			firstPrompt: "run the tests",
		});
		expect(await latestSessionId(cwd)).not.toBe("legacy");

		expect(await resolveSessionId("leg", cwd)).toBe("legacy");
		await expect(resolveSessionId("nope", cwd)).rejects.toThrow(/No saved session/);
		await writeFile(sessionPath("first-b", cwd), "");
		await expect(resolveSessionId("fir", cwd)).rejects.toThrow(/matches 2 sessions/);
		expect(await resolveSessionId("first", cwd)).toBe("first");
	});

	it("drives /evidence, /claims, /clear, /resume and /compact through the command registry", async () => {
		const out: string[] = [];
		const state: ReplState = {
			session: ActiveSession.create("repl", "scripted", "scripted", cwd),
			cwd,
			summarizer: () => async () => "summary from test",
		};
		const exec = (line: string) =>
			runCommandLine(line, { state, commands: BUILTIN_COMMANDS, print: (t) => out.push(t) });

		expect((await exec("/resume first")).handled).toBe(true);
		expect(state.session.id).toBe("first");
		expect(out.at(-1)).toMatch(/Resumed first .*2 evidence entries/);

		await exec("/evidence");
		expect(out.at(-1)).toMatch(/c1\s+Bash\s+`echo .*exit 1/);
		await exec("/claims");
		expect(out.at(-1)).toMatch(/flagged/);
		expect(out.at(-1)).toContain("[FALSE CLAIM] tests_pass c1");

		await exec("/compact");
		expect(out.at(-1)).toMatch(/Compacted \d+ older messages/);
		expect(JSON.stringify(state.session.history)).toContain("summary from test");

		await exec("/clear");
		expect(state.session.history).toEqual([]);
		expect(state.session.evidence.all()).toHaveLength(2);
		expect((await loadSession("first", cwd))?.messages).toEqual([]);

		await exec("/nope");
		expect(out.at(-1)).toContain("Unknown command /nope");
		expect((await exec("/usr/bin/env is broken")).handled).toBe(false);
		expect(await exec("/quit")).toMatchObject({ handled: true, exit: true });
	});
});

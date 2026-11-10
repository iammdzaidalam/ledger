import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import { runTurn } from "../src/modes/turn.js";
import {
	flushRecorders,
	observe,
	recorderFor,
	TurnRecorder,
	type TurnSink,
	toWire,
} from "../src/server/recorder.js";
import { ActiveSession } from "../src/session/active.js";
import type { RecordTurnRequest } from "../src/swarm/types.js";
import { startFakeServer } from "./fleet-support.js";
import { scriptedProvider } from "./helpers.js";

function log(): EvidenceLog {
	const evidence = new EvidenceLog();
	evidence.record("bash", {
		args: { command: "npm test" },
		raw_stdout: "ok",
		raw_stderr: "",
		exit_code: 0,
		executed: true,
		is_error: false,
		duration_ms: 12.6,
	});
	return evidence;
}

describe("toWire", () => {
	it("maps evidence to protojson field names", () => {
		const [entry] = log().all();
		expect(entry && toWire(entry)).toEqual({
			ref: "c1",
			seq: 1,
			tool: "bash",
			args: { command: "npm test" },
			rawStdout: "ok",
			rawStderr: "",
			exitCode: 0,
			executed: true,
			isError: false,
			durationMs: "13",
		});
	});

	it("leaves out the exit code when the command never ran", () => {
		const evidence = new EvidenceLog();
		const entry = evidence.record("bash", {
			args: {},
			raw_stdout: "",
			raw_stderr: "denied",
			exit_code: null,
			executed: false,
			is_error: true,
			duration_ms: 0,
		});
		expect("exitCode" in toWire(entry)).toBe(false);
	});
});

describe("TurnRecorder", () => {
	it("posts the turn text, the whole evidence log and only the new refs", async () => {
		const sent: RecordTurnRequest[] = [];
		const sink: TurnSink = {
			recordTurn: async (request) => {
				sent.push(request);
				return {};
			},
		};
		const recorder = new TurnRecorder(sink, "run-1", "qwen", "fix the bug");
		const evidence = log();
		recorder.record("first", evidence);
		evidence.record("bash", {
			args: { command: "ls" },
			raw_stdout: "",
			raw_stderr: "",
			exit_code: 0,
			executed: true,
			is_error: false,
			duration_ms: 1,
		});
		recorder.record("second", evidence);
		recorder.record("", evidence);
		await recorder.flush();

		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatchObject({
			runId: "run-1",
			turn: 1,
			turnText: "first",
			freshRefs: ["c1"],
			run: { source: "ledger-cli", model: "qwen", task: "fix the bug" },
		});
		expect(sent[0]?.evidence).toHaveLength(1);
		expect(sent[1]).toMatchObject({ turn: 2, turnText: "second", freshRefs: ["c2"] });
		expect(sent[1]?.evidence.map((e) => e.ref)).toEqual(["c1", "c2"]);
	});

	it("does not block when the server never answers", async () => {
		const sink: TurnSink = { recordTurn: () => new Promise(() => {}) };
		const recorder = new TurnRecorder(sink, "r", "m", "t");
		const started = performance.now();
		recorder.record("text", log());
		expect(performance.now() - started).toBeLessThan(50);
		const flushStarted = performance.now();
		await flushRecorders(60);
		expect(performance.now() - flushStarted).toBeLessThan(1000);
	});

	it("warns once and keeps going when sends fail", async () => {
		const warnings: string[] = [];
		const sink: TurnSink = { recordTurn: vi.fn().mockRejectedValue(new Error("refused")) };
		const recorder = new TurnRecorder(sink, "r", "m", "t", 0, (message) => warnings.push(message));
		const evidence = log();
		recorder.record("one", evidence);
		recorder.record("two", evidence);
		recorder.record("three", evidence);
		await recorder.flush();
		expect(sink.recordTurn).toHaveBeenCalledTimes(3);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("refused");
	});

	it("only reacts to assistant turns", () => {
		const sent: string[] = [];
		const recorder = new TurnRecorder(
			{
				recordTurn: async (r) => {
					sent.push(r.turnText);
					return {};
				},
			},
			"r",
			"m",
			"t",
		);
		observe(recorder, { type: "text_delta", delta: "x" }, log());
		observe(recorder, { type: "assistant_turn", turn: 1, text: "done", toolCalls: 0 }, log());
		observe(undefined, { type: "assistant_turn", turn: 1, text: "ignored", toolCalls: 0 }, log());
		return recorder.flush().then(() => expect(sent).toEqual(["done"]));
	});
});

describe("recorderFor", () => {
	const session = () =>
		ActiveSession.create("sess-1", "ollama", "qwen2.5:7b", mkdtempSync(join(tmpdir(), "ledger-rec-")));

	it("is off without a server", () => {
		expect(recorderFor(session(), "hi", {})).toBeUndefined();
	});

	it("is on when LEDGER_SERVER is set and is shared per session", () => {
		const s = session();
		const first = recorderFor(s, "hi", { LEDGER_SERVER: "http://localhost:1" });
		expect(first).toBeInstanceOf(TurnRecorder);
		expect(recorderFor(s, "later", {})).toBe(first);
	});
});

describe("runTurn recording", () => {
	it("posts each assistant turn to the server named in LEDGER_SERVER, under LEDGER_RUN_ID", async () => {
		const server = await startFakeServer();
		const previous = { server: process.env.LEDGER_SERVER, run: process.env.LEDGER_RUN_ID };
		process.env.LEDGER_SERVER = server.url;
		process.env.LEDGER_RUN_ID = "attempt-run-7";
		const dir = mkdtempSync(join(tmpdir(), "ledger-rec-"));
		const session = ActiveSession.create("sess-2", "ollama", "qwen2.5:7b", dir);
		const events: string[] = [];
		const grounding = new GroundingClient();
		try {
			await runTurn(
				session,
				"say hello",
				{ system: "s", provider: scriptedProvider([{ text: "Hello there." }]), validate: "off" },
				grounding,
				(event) => void events.push(event.type),
			);
			await flushRecorders();
		} finally {
			grounding.close();
			process.env.LEDGER_SERVER = previous.server;
			process.env.LEDGER_RUN_ID = previous.run;
			if (previous.server === undefined) delete process.env.LEDGER_SERVER;
			if (previous.run === undefined) delete process.env.LEDGER_RUN_ID;
			await server.close();
		}
		expect(server.turns).toHaveLength(1);
		expect(server.turns[0]).toMatchObject({
			runId: "attempt-run-7",
			turn: 1,
			turnText: "Hello there.",
			run: { source: "ledger-cli", model: "qwen2.5:7b", task: "say hello" },
		});
	});
});

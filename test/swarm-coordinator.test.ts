import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerClient } from "../src/swarm/client.js";
import { type CoordinatorOptions, idempotencyKey, runCoordinator } from "../src/swarm/coordinator.js";
import { formatSummary } from "../src/swarm/report.js";
import { addTaskWorktree, commitAll, resolveCommit } from "../src/swarm/worktree.js";
import {
	type FakeBehavior,
	type FakeServer,
	fakeLauncher,
	makeRepo,
	sh,
	startFakeServer,
	until,
} from "./fleet-support.js";

let server: FakeServer;
let repo: string;
let lines: string[];

beforeEach(async () => {
	server = await startFakeServer();
	repo = makeRepo();
	lines = [];
});

afterEach(async () => {
	await server.close();
	rmSync(repo, { recursive: true, force: true });
});

function options(
	behavior: (prompt: string) => FakeBehavior,
	extra: Partial<CoordinatorOptions> = {},
): CoordinatorOptions {
	return {
		cwd: repo,
		server: server.url,
		goal: "ship it",
		workers: 2,
		gate: true,
		maxAttempts: 3,
		subtasks: ["edit a", "edit b"],
		provider: "ollama",
		model: "m",
		log: (line) => lines.push(line),
		launcher: fakeLauncher((request) => behavior(request.prompt)),
		pollMs: 20,
		heartbeatMs: 200,
		graceMs: 300,
		...extra,
	};
}

const edits = (prompt: string): FakeBehavior => ({
	writes: prompt === "edit a" ? { "a.txt": "A2\n" } : { "b.txt": "B2\n" },
});

describe("coordinator", () => {
	it("runs subtasks in parallel worktrees and lands them on the integration branch", async () => {
		const head = sh(repo, "rev-parse", "HEAD");
		const outcome = await runCoordinator(options(edits));

		expect(outcome.exitCode).toBe(0);
		expect(outcome.branch).toBe("ledger/s1/integration");
		expect(outcome.result.tasks?.map((t) => t.state)).toEqual(["TASK_STATE_MERGED", "TASK_STATE_MERGED"]);
		expect(sh(repo, "show", "ledger/s1/integration:a.txt")).toBe("A2");
		expect(sh(repo, "show", "ledger/s1/integration:b.txt")).toBe("B2");
		expect(sh(repo, "log", "--merges", "--format=%s", "ledger/s1/integration").split("\n")).toHaveLength(2);

		expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
		expect(sh(repo, "branch", "--show-current")).toBe("main");
		expect(sh(repo, "status", "--porcelain")).toBe("");
		expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("a\n");
		expect(existsSync(join(repo, ".ledger", "fleet", "s1"))).toBe(false);
		expect(sh(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);

		const summary = formatSummary(outcome.result, outcome.branch);
		expect(summary).toContain("edit a");
		expect(summary).toContain("pass");
		expect(summary).toContain("merged");
		expect(summary).toContain("git merge ledger/s1/integration");
		expect(lines.join("\n")).toContain("attempt.started edit a: attempt 1");
	});

	it("creates the swarm with the gate flag, base commit and model", async () => {
		const base = await resolveCommit(repo, "HEAD");
		await runCoordinator(options(edits, { gate: false, maxAttempts: 5 }));
		const swarm = server.swarms.get("s1");
		expect(swarm?.request).toMatchObject({
			goal: "ship it",
			repo,
			baseRef: base,
			model: "m",
			gate: false,
			maxAttempts: 5,
			idempotencyKey: idempotencyKey("ship it", base),
		});
		expect(swarm?.request.subtasks.map((s) => s.title)).toEqual(["edit a", "edit b"]);
	});

	it("exits 2 and leaves the integration branch clean when two branches conflict", async () => {
		const outcome = await runCoordinator(
			options((prompt) => ({ writes: { "shared.txt": `${prompt}\n` } }), { workers: 1 }),
		);
		expect(outcome.exitCode).toBe(2);
		const states = outcome.result.tasks?.map((t) => t.state);
		expect(states).toEqual(["TASK_STATE_MERGED", "TASK_STATE_CONFLICT"]);
		expect(outcome.result.tasks?.[1]?.detail).toContain("shared.txt");
		expect(sh(repo, "show", "ledger/s1/integration:shared.txt")).toBe("edit a");
		expect(sh(repo, "log", "--merges", "--format=%s", "ledger/s1/integration").split("\n")).toHaveLength(1);
		expect(formatSummary(outcome.result, outcome.branch)).toContain("conflict");
	});

	it("retries a task the gate sends back and then merges it", async () => {
		server.decide = (_completion, _task, attempt) =>
			attempt.number === 1
				? { decision: "GATE_DECISION_RETRY", reason: "claimed a pass" }
				: { decision: "GATE_DECISION_PASS" };
		const outcome = await runCoordinator(options(edits, { subtasks: ["edit a"] }));
		expect(outcome.exitCode).toBe(0);
		expect(outcome.result.tasks?.[0]?.attempts).toHaveLength(2);
		expect(formatSummary(outcome.result, outcome.branch)).toContain("2");
	});

	it("exits 2 when the gate blocks a task and does not merge it", async () => {
		server.decide = (_c, task) =>
			task.title === "edit b" ? { decision: "GATE_DECISION_BLOCK" } : { decision: "GATE_DECISION_PASS" };
		const outcome = await runCoordinator(options(edits));
		expect(outcome.exitCode).toBe(2);
		expect(outcome.result.tasks?.map((t) => t.state)).toEqual(["TASK_STATE_MERGED", "TASK_STATE_BLOCKED"]);
		expect(sh(repo, "show", "ledger/s1/integration:b.txt")).toBe("b");
		const summary = formatSummary(outcome.result, outcome.branch);
		expect(summary).toContain("block");
		expect(summary).not.toContain("To take the changes");
	});

	it("attaches to an existing swarm created with the same goal and base commit", async () => {
		const client = new LedgerClient({ baseUrl: server.url, retries: 0 });
		const base = await resolveCommit(repo, "HEAD");
		await client.createSwarm({
			idempotencyKey: idempotencyKey("ship it", base),
			goal: "ship it",
			subtasks: [
				{ title: "edit a", prompt: "edit a" },
				{ title: "edit b", prompt: "edit b" },
			],
			repo,
			baseRef: base,
			model: "m",
			gate: true,
			maxAttempts: 3,
		});
		const outcome = await runCoordinator(options(edits));
		expect(server.created).toBe(1);
		expect(lines).toContain("attached to existing swarm s1");
		expect(outcome.exitCode).toBe(0);
	});

	it("resumes by id and continues from a crashed worker's commit", async () => {
		const client = new LedgerClient({ baseUrl: server.url, retries: 0 });
		const base = await resolveCommit(repo, "HEAD");
		await client.createSwarm({
			idempotencyKey: "other",
			goal: "ship it",
			subtasks: [{ title: "edit a", prompt: "edit a" }],
			repo,
			baseRef: base,
			model: "m",
			gate: true,
			maxAttempts: 3,
		});
		const left = await addTaskWorktree(repo, "s1", 0, base);
		writeFileSync(join(left.path, "crash.txt"), "left behind\n");
		await commitAll(left.path, "partial work");
		const log = join(repo, "..", `resume-${Math.random().toString(36).slice(2)}.jsonl`);

		const outcome = await runCoordinator(
			options((prompt) => ({ ...edits(prompt), log }), { resume: "s1", goal: undefined, subtasks: [] }),
		);
		const start = JSON.parse(readFileSync(log, "utf-8").split("\n")[0] ?? "{}");
		rmSync(log, { force: true });
		expect(outcome.exitCode).toBe(0);
		expect(server.created).toBe(1);
		expect(start.files).toContain("crash.txt");
		expect(sh(repo, "show", "ledger/s1/integration:crash.txt")).toBe("left behind");
	});

	it("refuses to resume a cancelled swarm", async () => {
		const aborter = new AbortController();
		const run = runCoordinator(options(() => ({ sleepMs: 30_000 }), { signal: aborter.signal }));
		await until(() => server.swarms.get("s1")?.tasks.some((t) => t.state === "TASK_STATE_RUNNING") === true);
		aborter.abort();
		await run;
		await expect(runCoordinator(options(edits, { resume: "s1" }))).rejects.toThrow("was cancelled");
	});

	it("cancels cleanly on abort: swarm cancelled, children killed, worktrees removed", async () => {
		const aborter = new AbortController();
		const run = runCoordinator(
			options(() => ({ sleepMs: 30_000, writes: { "a.txt": "half\n" } }), { signal: aborter.signal }),
		);
		await until(() => server.swarms.get("s1")?.tasks.every((t) => t.state === "TASK_STATE_RUNNING") === true);
		const started = Date.now();
		aborter.abort();
		const outcome = await run;
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(outcome.cancelled).toBe(true);
		expect(outcome.exitCode).toBe(130);
		expect(server.swarms.get("s1")?.state).toBe("SWARM_STATE_CANCELLED");
		expect(existsSync(join(repo, ".ledger", "fleet", "s1"))).toBe(false);
		expect(sh(repo, "status", "--porcelain")).toBe("");
		expect(server.completions).toHaveLength(0);
	});
});

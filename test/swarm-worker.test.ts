import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerClient } from "../src/swarm/client.js";
import { Worker, withFeedback } from "../src/swarm/worker.js";
import { resolveCommit, taskPath } from "../src/swarm/worktree.js";
import { type FakeServer, fakeLauncher, makeRepo, sh, startFakeServer, until } from "./fleet-support.js";

let server: FakeServer;
let repo: string;
let log: string;

beforeEach(async () => {
	server = await startFakeServer();
	repo = makeRepo();
	log = join(tmpdir(), `fake-child-${Math.random().toString(36).slice(2)}.jsonl`);
});

afterEach(async () => {
	await server.close();
	rmSync(repo, { recursive: true, force: true });
	rmSync(log, { force: true });
});

function seen(): {
	prompt: string;
	head: string;
	files: string[];
	cwd: string;
	runId: string;
	server: string;
}[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function create(prompt = "do the thing", gate = true) {
	const client = new LedgerClient({ baseUrl: server.url, retries: 0 });
	const base = await resolveCommit(repo, "HEAD");
	const { swarm } = await client.createSwarm({
		idempotencyKey: "k",
		goal: "g",
		subtasks: [{ title: "task", prompt }],
		repo,
		baseRef: base,
		model: "m",
		gate,
		maxAttempts: 3,
	});
	return { client, base, swarmId: swarm.id };
}

function makeWorker(
	client: LedgerClient,
	swarmId: string,
	launcher: ReturnType<typeof fakeLauncher>,
	extra = {},
) {
	return new Worker({
		client,
		repo,
		workerId: "w1",
		swarmId,
		leaseSeconds: 30,
		provider: "ollama",
		model: "m",
		server: server.url,
		launcher,
		pollMs: 20,
		...extra,
	});
}

describe("worker", () => {
	it("runs the child in the worktree with the server and run id, then completes the attempt", async () => {
		const { client, swarmId, base } = await create();
		const launcher = fakeLauncher(() => ({ writes: { "a.txt": "edited\n", "new.txt": "n\n" }, log }));
		const controller = new AbortController();
		const run = makeWorker(client, swarmId, launcher).run(controller.signal);
		await until(() => server.completions.length === 1);
		controller.abort();
		await run;

		const [start] = seen();
		expect(start?.cwd).toBe(taskPath(repo, swarmId, 0));
		expect(start?.server).toBe(server.url);
		expect(start?.runId).toBe("run-s1-t0-a1");
		expect(start?.prompt).toBe("do the thing");

		const [done] = server.completions;
		expect(done).toMatchObject({ attemptId: "s1-t0-a1", workerId: "w1", exitCode: 0, branch: "ledger/s1/0" });
		expect(done?.filesChanged.sort()).toEqual(["a.txt", "new.txt"]);
		expect(done?.commit).toBe(sh(repo, "rev-parse", "ledger/s1/0"));
		expect(done?.commit).not.toBe(base);
	});

	it("on retry carries the feedback in the prompt and continues from the previous commit", async () => {
		const { client, swarmId } = await create("make it work");
		server.decide = (completion, _task, attempt) =>
			attempt.number === 1
				? { decision: "GATE_DECISION_RETRY", reason: "you said tests pass but none ran" }
				: { decision: completion.exitCode === 0 ? "GATE_DECISION_PASS" : "GATE_DECISION_FAIL" };
		const launcher = fakeLauncher((request) => ({
			writes: request.prompt.startsWith("Your previous attempt")
				? { "second.txt": "2\n" }
				: { "first.txt": "1\n" },
			log,
		}));
		const controller = new AbortController();
		const run = makeWorker(client, swarmId, launcher).run(controller.signal);
		await until(() => server.completions.length === 2);
		controller.abort();
		await run;

		const [first, second] = seen();
		expect(first?.prompt).toBe("make it work");
		expect(second?.prompt).toBe(
			"Your previous attempt made claims the recorded tool evidence does not support: you said tests pass but none ran\n\nmake it work",
		);
		expect(second?.cwd).toBe(first?.cwd);
		expect(second?.files).toContain("first.txt");
		expect(second?.head).toBe(server.completions[0]?.commit);
		expect(server.completions[1]?.filesChanged.sort()).toEqual(["first.txt", "second.txt"]);
		expect(sh(taskPath(repo, swarmId, 0), "rev-list", "--count", "HEAD")).toBe("3");
	});

	it("reports no commit when the child changed nothing", async () => {
		const { client, swarmId } = await create();
		const launcher = fakeLauncher(() => ({ log }));
		const controller = new AbortController();
		const run = makeWorker(client, swarmId, launcher).run(controller.signal);
		await until(() => server.completions.length === 1);
		controller.abort();
		await run;
		expect(server.completions[0]).toMatchObject({ exitCode: 0, commit: "", branch: "", filesChanged: [] });
	});

	it("reports a failing child with its exit code and keeps going", async () => {
		const { client, swarmId } = await create();
		const launcher = fakeLauncher(() => ({ exit: 1 }));
		const controller = new AbortController();
		const run = makeWorker(client, swarmId, launcher).run(controller.signal);
		await until(() => server.completions.length === 1);
		controller.abort();
		await run;
		expect(server.completions[0]).toMatchObject({ exitCode: 1 });
	});

	async function claimed(client: LedgerClient, swarmId: string) {
		const claim = await client.claimAttempt({ workerId: "w1", leaseSeconds: 30, swarmId });
		if (!claim.assignment) throw new Error("nothing to claim");
		return claim.assignment;
	}

	it("kills the child and drops the attempt when the lease is lost", async () => {
		const { client, swarmId } = await create();
		server.heartbeat = (count) => (count >= 2 ? { leaseHeld: false } : { leaseHeld: true });
		const launcher = fakeLauncher(() => ({ sleepMs: 30_000, writes: { "partial.txt": "x\n" } }));
		const worker = makeWorker(client, swarmId, launcher, { heartbeatMs: 40 });
		const started = Date.now();
		const report = await worker.attempt(await claimed(client, swarmId), new AbortController().signal);
		expect(report.lost).toBe("lease lost");
		expect(report.exitCode).toBe(143);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(server.heartbeats).toBe(2);
		expect(server.completions).toHaveLength(0);
	});

	it("kills the child when the swarm is cancelled", async () => {
		const { client, swarmId } = await create();
		const launcher = fakeLauncher(() => ({ sleepMs: 30_000 }));
		const worker = makeWorker(client, swarmId, launcher, { heartbeatMs: 40 });
		const assignment = await claimed(client, swarmId);
		setTimeout(() => void client.cancelSwarm(swarmId), 100);
		const report = await worker.attempt(assignment, new AbortController().signal);
		expect(report.lost).toBe("swarm cancelled");
		expect(server.completions).toHaveLength(0);
	});

	it("tolerates heartbeat errors until the lease would have run out", async () => {
		const { client, swarmId } = await create();
		const flaky = new LedgerClient({
			baseUrl: server.url,
			retries: 0,
			fetch: ((url: string, init: RequestInit) =>
				String(url).endsWith("/Heartbeat")
					? Promise.reject(new Error("network down"))
					: fetch(url, init)) as unknown as typeof fetch,
		});
		const launcher = fakeLauncher(() => ({ sleepMs: 400 }));
		const worker = makeWorker(flaky, swarmId, launcher, { heartbeatMs: 40 });
		const report = await worker.attempt(await claimed(client, swarmId), new AbortController().signal);
		expect(report.lost).toBeUndefined();
		expect(report.exitCode).toBe(0);
		expect(server.completions).toHaveLength(1);
	});

	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const { client, swarmId } = await create();
		server.heartbeat = () => ({ leaseHeld: false });
		const launcher = fakeLauncher(() => ({ sleepMs: 30_000, ignoreTerm: true }));
		const worker = makeWorker(client, swarmId, launcher, { heartbeatMs: 300, graceMs: 200 });
		const started = Date.now();
		const report = await worker.attempt(await claimed(client, swarmId), new AbortController().signal);
		expect(report.lost).toBe("lease lost");
		expect(report.exitCode).toBe(137);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("stops the child when the worker is aborted", async () => {
		const { client, swarmId } = await create();
		const launcher = fakeLauncher(() => ({ sleepMs: 30_000 }));
		const worker = makeWorker(client, swarmId, launcher, { heartbeatMs: 5000 });
		const controller = new AbortController();
		const assignment = await claimed(client, swarmId);
		setTimeout(() => controller.abort(), 150);
		const report = await worker.attempt(assignment, controller.signal);
		expect(report.exitCode).toBe(143);
		expect(server.completions).toHaveLength(0);
	});

	it("prefixes feedback only when there is some", () => {
		expect(withFeedback("p", undefined)).toBe("p");
		expect(withFeedback("p", "")).toBe("p");
		expect(withFeedback("p", "f")).toContain("f\n\np");
	});
});

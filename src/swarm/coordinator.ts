import { createHash } from "node:crypto";
import { getApiKey } from "../agent/loop.js";
import { createProvider } from "../providers/index.js";
import type { Provider } from "../providers/types.js";
import { type Launcher, ledgerLauncher } from "./child.js";
import { LedgerClient } from "./client.js";
import { readEvents } from "./events.js";
import { runMergeQueue } from "./merge.js";
import { listRepoFiles, planSubtasks, singleSubtask } from "./planner.js";
import { allMerged } from "./report.js";
import type { GetSwarmResponse, SubtaskSpec, SwarmEvent } from "./types.js";
import { Worker, workerName } from "./worker.js";
import { excludeFleet, integrationBranch, removeFleet, repoRoot, resolveCommit } from "./worktree.js";

export interface CoordinatorOptions {
	cwd: string;
	server: string;
	goal?: string;
	workers: number;
	gate: boolean;
	maxAttempts: number;
	plan?: number;
	subtasks: string[];
	base?: string;
	resume?: string;
	provider: string;
	model: string;
	signal?: AbortSignal;
	log: (line: string) => void;
	client?: LedgerClient;
	planner?: Provider;
	launcher?: Launcher;
	leaseSeconds?: number;
	pollMs?: number;
	heartbeatMs?: number;
	graceMs?: number;
}

export interface SwarmOutcome {
	swarmId: string;
	result: GetSwarmResponse;
	branch: string;
	exitCode: number;
	cancelled: boolean;
}

export const CANCELLED_EXIT_CODE = 130;
export const FAILED_EXIT_CODE = 2;

export function idempotencyKey(goal: string, baseCommit: string): string {
	return createHash("sha256").update(`${goal}\n${baseCommit}`).digest("hex").slice(0, 32);
}

function specFromText(text: string): SubtaskSpec {
	const first = text.split("\n")[0]?.trim() ?? text;
	return { title: first.length > 72 ? `${first.slice(0, 69)}...` : first, prompt: text };
}

async function planFor(options: CoordinatorOptions, repo: string, goal: string): Promise<SubtaskSpec[]> {
	if (options.subtasks.length > 0) return options.subtasks.map(specFromText);
	const max = options.plan ?? options.workers;
	try {
		const provider = options.planner ?? createProvider(options.provider, getApiKey(options.provider));
		return await planSubtasks({
			goal,
			files: await listRepoFiles(repo),
			provider,
			model: options.model,
			max,
			signal: options.signal,
		});
	} catch {
		return singleSubtask(goal);
	}
}

interface Target {
	swarmId: string;
	baseRef: string;
}

async function attach(options: CoordinatorOptions, client: LedgerClient, repo: string): Promise<Target> {
	if (options.resume) {
		const { swarm } = await client.getSwarm(options.resume);
		if (swarm.state === "SWARM_STATE_CANCELLED") throw new Error(`swarm ${swarm.id} was cancelled`);
		return { swarmId: swarm.id, baseRef: swarm.baseRef || "HEAD" };
	}
	const goal = options.goal ?? "";
	const baseCommit = await resolveCommit(repo, options.base ?? "HEAD");
	const subtasks = await planFor(options, repo, goal);
	const created = await client.createSwarm({
		idempotencyKey: idempotencyKey(goal, baseCommit),
		goal,
		subtasks,
		repo,
		baseRef: baseCommit,
		model: options.model,
		gate: options.gate,
		maxAttempts: options.maxAttempts,
	});
	if (created.swarm.state === "SWARM_STATE_CANCELLED")
		throw new Error(`swarm ${created.swarm.id} was cancelled`);
	if (created.duplicate) options.log(`attached to existing swarm ${created.swarm.id}`);
	return { swarmId: created.swarm.id, baseRef: created.swarm.baseRef || baseCommit };
}

function describe(event: SwarmEvent, titles: Map<string, string>): string {
	const task = event.taskId ? (titles.get(event.taskId) ?? event.taskId) : "";
	const head = [event.type, task].filter(Boolean).join(" ");
	return event.message ? `${head}: ${event.message}` : head;
}

async function follow(
	options: CoordinatorOptions,
	client: LedgerClient,
	swarmId: string,
	signal: AbortSignal,
): Promise<void> {
	const titles = new Map<string, string>();
	try {
		const { tasks } = await client.getSwarm(swarmId);
		for (const task of tasks ?? []) titles.set(task.id, task.title || task.id);
	} catch {}
	for await (const event of readEvents(options.server, swarmId, signal)) options.log(describe(event, titles));
}

export async function runCoordinator(options: CoordinatorOptions): Promise<SwarmOutcome> {
	const repo = await repoRoot(options.cwd);
	await excludeFleet(repo);
	const client = options.client ?? new LedgerClient({ baseUrl: options.server });
	const target = await attach(options, client, repo);
	const { swarmId, baseRef } = target;
	const branch = integrationBranch(swarmId);
	options.log(`swarm ${swarmId}`);

	const stop = new AbortController();
	let cancelled = false;
	const onCancel = () => {
		cancelled = true;
		stop.abort();
	};
	if (options.signal?.aborted) onCancel();
	options.signal?.addEventListener("abort", onCancel, { once: true });

	const lease = options.leaseSeconds ?? 60;
	const launcher = options.launcher ?? ledgerLauncher;
	const workers = Array.from({ length: options.workers }, (_, i) =>
		new Worker({
			client,
			repo,
			workerId: workerName(i),
			swarmId,
			leaseSeconds: lease,
			provider: options.provider,
			model: options.model,
			server: options.server,
			launcher,
			pollMs: options.pollMs,
			heartbeatMs: options.heartbeatMs,
			graceMs: options.graceMs,
			log: options.log,
		}).run(stop.signal),
	);
	const progress = follow(options, client, swarmId, stop.signal);
	let failure: unknown;
	try {
		await runMergeQueue(
			{
				client,
				repo,
				swarmId,
				baseRef,
				workerId: `${workerName(0)}-merge`,
				leaseSeconds: lease,
				pollMs: options.pollMs,
				log: options.log,
			},
			stop.signal,
		);
	} catch (err) {
		failure = err;
	}
	if (cancelled) await client.cancelSwarm(swarmId).catch(() => undefined);
	stop.abort();
	options.signal?.removeEventListener("abort", onCancel);
	await Promise.allSettled([...workers, progress]);
	const result = await client.getSwarm(swarmId).catch(() => ({ swarm: { id: swarmId }, tasks: [] }));
	await removeFleet(repo, swarmId);
	if (failure) throw failure;

	const exitCode = cancelled ? CANCELLED_EXIT_CODE : allMerged(result) ? 0 : FAILED_EXIT_CODE;
	return { swarmId, result, branch, exitCode, cancelled };
}

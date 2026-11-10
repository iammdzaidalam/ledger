import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { type ChildHandle, type Launcher, startChild } from "./child.js";
import type { LedgerClient } from "./client.js";
import type { Assignment, GateDecision } from "./types.js";
import { addTaskWorktree, changedFiles, commitAll, taskBranch } from "./worktree.js";

export type WorkerApi = Pick<LedgerClient, "claimAttempt" | "heartbeat" | "completeAttempt" | "getSwarm">;

export interface WorkerConfig {
	client: WorkerApi;
	repo: string;
	workerId: string;
	swarmId?: string;
	leaseSeconds: number;
	provider: string;
	model: string;
	server: string;
	launcher: Launcher;
	pollMs?: number;
	heartbeatMs?: number;
	graceMs?: number;
	log?: (line: string) => void;
}

export interface AttemptReport {
	taskId: string;
	attemptId: string;
	exitCode: number;
	decision?: GateDecision;
	lost?: string;
}

export function workerName(n: number): string {
	return `${hostname()}-${process.pid}-${n}`;
}

export function withFeedback(prompt: string, feedback: string | undefined): string {
	if (!feedback) return prompt;
	return `Your previous attempt made claims the recorded tool evidence does not support: ${feedback}\n\n${prompt}`;
}

const UNVERIFIED_EXIT = 2;
const SUMMARY_CHARS = 1000;

export class Worker {
	private readonly indexes = new Map<string, number>();
	private readonly pollMs: number;
	private readonly log: (line: string) => void;

	constructor(private readonly config: WorkerConfig) {
		this.pollMs = config.pollMs ?? 1000;
		this.log = config.log ?? (() => undefined);
	}

	private async indexOf(swarmId: string, taskId: string): Promise<number> {
		const known = this.indexes.get(taskId);
		if (known !== undefined) return known;
		const { tasks } = await this.config.client.getSwarm(swarmId);
		for (const task of tasks ?? []) this.indexes.set(task.id, task.index ?? 0);
		return this.indexes.get(taskId) ?? 0;
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			let assignment: Assignment | undefined;
			try {
				const claim = await this.config.client.claimAttempt({
					workerId: this.config.workerId,
					leaseSeconds: this.config.leaseSeconds,
					swarmId: this.config.swarmId,
				});
				assignment = claim.assignment?.attemptId ? claim.assignment : undefined;
			} catch (err) {
				this.log(`claim failed: ${(err as Error).message}`);
			}
			if (!assignment) {
				await sleep(this.pollMs, undefined, { signal }).catch(() => undefined);
				continue;
			}
			try {
				await this.attempt(assignment, signal);
			} catch (err) {
				this.log(`attempt ${assignment.attemptId} failed: ${(err as Error).message}`);
			}
		}
	}

	async attempt(assignment: Assignment, signal: AbortSignal): Promise<AttemptReport> {
		const { client, repo, workerId } = this.config;
		const report: AttemptReport = { taskId: assignment.taskId, attemptId: assignment.attemptId, exitCode: 1 };
		const index = await this.indexOf(assignment.swarmId, assignment.taskId);
		const branch = assignment.branch || taskBranch(assignment.swarmId, index);
		const baseRef = assignment.baseRef || "HEAD";
		let commit = "";
		let files: string[] = [];
		let summary = "";
		let error = "";

		try {
			const checkout = await addTaskWorktree(repo, assignment.swarmId, index, baseRef, branch);
			this.log(
				`${assignment.title ?? assignment.taskId}: attempt ${assignment.attemptNumber ?? "?"} started`,
			);
			const spec = this.config.launcher({
				cwd: checkout.path,
				prompt: withFeedback(assignment.prompt, assignment.feedback),
				runId: assignment.runId,
				provider: this.config.provider,
				model: assignment.model || this.config.model,
				server: this.config.server,
			});
			const child = startChild(spec, checkout.path, this.config.graceMs);
			const lost = await this.supervise(assignment, child, signal);
			const result = await child.done;
			report.exitCode = result.code;
			if (lost) {
				report.lost = lost;
				this.log(`${assignment.title ?? assignment.taskId}: stopped, ${lost}`);
				return report;
			}
			if (signal.aborted) return report;
			if (result.code !== 0 && result.code !== UNVERIFIED_EXIT)
				error = result.stderr.trim().slice(-SUMMARY_CHARS);
			summary = result.stdout.trim().slice(-SUMMARY_CHARS);
			commit = await commitAll(
				checkout.path,
				`ledger: ${assignment.title ?? assignment.taskId} (attempt ${assignment.attemptNumber ?? 1})`,
			);
			files = await changedFiles(checkout.path, baseRef);
			if (files.length === 0) commit = "";
		} catch (err) {
			error = (err as Error).message;
			report.exitCode = 1;
		}

		const response = await client.completeAttempt({
			attemptId: assignment.attemptId,
			workerId,
			exitCode: report.exitCode,
			branch: commit ? branch : "",
			commit,
			filesChanged: files,
			summary,
			error,
		});
		report.decision = response.decision;
		return report;
	}

	private async supervise(
		assignment: Assignment,
		child: ChildHandle,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const lease = assignment.leaseSeconds || this.config.leaseSeconds;
		const every = this.config.heartbeatMs ?? Math.max(1000, (lease * 1000) / 3);
		const stop = new AbortController();
		let lost: string | undefined;
		const onAbort = () => void child.stop();
		signal.addEventListener("abort", onAbort, { once: true });
		const beats = (async () => {
			let lastOk = Date.now();
			while (!stop.signal.aborted) {
				await sleep(every, undefined, { signal: stop.signal }).catch(() => undefined);
				if (stop.signal.aborted) return;
				try {
					const beat = await this.config.client.heartbeat(assignment.attemptId, this.config.workerId);
					lastOk = Date.now();
					if (beat.cancelled) lost = "swarm cancelled";
					else if (beat.leaseHeld !== true) lost = "lease lost";
				} catch {
					if (Date.now() - lastOk > lease * 1000) lost = "server unreachable";
				}
				if (lost) {
					await child.stop();
					return;
				}
			}
		})();
		await child.done;
		stop.abort();
		await beats;
		signal.removeEventListener("abort", onAbort);
		return lost;
	}
}

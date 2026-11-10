import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildRequest, Launcher } from "../src/swarm/child.js";
import type {
	Attempt,
	CompleteAttemptRequest,
	CreateSwarmRequest,
	GateDecision,
	RecordTurnRequest,
	Task,
	TaskState,
} from "../src/swarm/types.js";

export const FAKE_CHILD = join(import.meta.dirname, "fixtures", "fake-child.mjs");

export function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function makeRepo(files: Record<string, string> = {}): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ledger-fleet-")));
	sh(dir, "init", "-q", "-b", "main");
	sh(dir, "config", "user.name", "tester");
	sh(dir, "config", "user.email", "tester@example.com");
	const all = { "a.txt": "a\n", "b.txt": "b\n", "shared.txt": "base\n", ...files };
	for (const [name, content] of Object.entries(all)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	sh(dir, "add", "-A");
	sh(dir, "commit", "-q", "-m", "initial");
	return dir;
}

export interface FakeBehavior {
	writes?: Record<string, string>;
	exit?: number;
	sleepMs?: number;
	ignoreTerm?: boolean;
	log?: string;
}

export function fakeLauncher(behavior: (request: ChildRequest) => FakeBehavior): Launcher {
	return (request) => ({
		command: process.execPath,
		args: [FAKE_CHILD, request.prompt],
		env: {
			...process.env,
			LEDGER_SERVER: request.server,
			LEDGER_RUN_ID: request.runId,
			FAKE_BEHAVIOR: JSON.stringify(behavior(request)),
		},
	});
}

const TERMINAL: TaskState[] = [
	"TASK_STATE_MERGED",
	"TASK_STATE_CONFLICT",
	"TASK_STATE_BLOCKED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELLED",
];

interface FakeTask extends Task {
	attempts: Attempt[];
	feedback: string;
	branch: string;
	commit: string;
}

interface FakeSwarm {
	id: string;
	request: CreateSwarmRequest;
	state: "SWARM_STATE_RUNNING" | "SWARM_STATE_DONE" | "SWARM_STATE_CANCELLED";
	tasks: FakeTask[];
}

export interface Decision {
	decision: GateDecision;
	reason?: string;
}

export interface FakeServer {
	url: string;
	swarms: Map<string, FakeSwarm>;
	turns: RecordTurnRequest[];
	completions: CompleteAttemptRequest[];
	created: number;
	heartbeats: number;
	decide: (completion: CompleteAttemptRequest, task: Task, attempt: Attempt) => Decision;
	heartbeat: (count: number) => { leaseHeld?: boolean; cancelled?: boolean };
	close: () => Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf-8");
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, body: unknown, status = 200): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

export async function startFakeServer(): Promise<FakeServer> {
	const keys = new Map<string, FakeSwarm>();
	const streams = new Set<ServerResponse>();
	const history: Record<string, string>[] = [];
	const state: FakeServer = {
		url: "",
		swarms: new Map(),
		turns: [],
		completions: [],
		created: 0,
		heartbeats: 0,
		decide: (completion) => ({
			decision: completion.exitCode === 0 ? "GATE_DECISION_PASS" : "GATE_DECISION_FAIL",
		}),
		heartbeat: () => ({ leaseHeld: true }),
		close: async () => {},
	};

	const emit = (swarmId: string, type: string, message: string, taskId = "") => {
		const event = { swarm_id: swarmId, task_id: taskId, type, message };
		history.push(event);
		for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
	};

	const view = (swarm: FakeSwarm) => ({
		id: swarm.id,
		goal: swarm.request.goal,
		repo: swarm.request.repo,
		baseRef: swarm.request.baseRef,
		model: swarm.request.model,
		state: swarm.state,
	});

	const refresh = (swarm: FakeSwarm) => {
		if (
			swarm.state === "SWARM_STATE_RUNNING" &&
			swarm.tasks.every((t) => TERMINAL.includes(t.state as TaskState))
		) {
			swarm.state = "SWARM_STATE_DONE";
		}
	};

	const find = (taskId: string): { swarm: FakeSwarm; task: FakeTask } | undefined => {
		for (const swarm of state.swarms.values()) {
			const task = swarm.tasks.find((t) => t.id === taskId);
			if (task) return { swarm, task };
		}
		return undefined;
	};

	const findAttempt = (attemptId: string) => {
		for (const swarm of state.swarms.values()) {
			for (const task of swarm.tasks) {
				const attempt = task.attempts.find((a) => a.id === attemptId);
				if (attempt) return { swarm, task, attempt };
			}
		}
		return undefined;
	};

	const handlers: Record<string, (body: Record<string, unknown>) => unknown> = {
		CreateSwarm: (body) => {
			const request = body as unknown as CreateSwarmRequest;
			const existing = keys.get(request.idempotencyKey);
			if (existing) return { swarm: view(existing), duplicate: true };
			state.created++;
			const id = `s${state.swarms.size + 1}`;
			const swarm: FakeSwarm = {
				id,
				request,
				state: "SWARM_STATE_RUNNING",
				tasks: request.subtasks.map((spec, index) => ({
					id: `${id}-t${index}`,
					swarmId: id,
					index,
					title: spec.title,
					prompt: spec.prompt,
					state: "TASK_STATE_QUEUED",
					attempts: [],
					feedback: "",
					branch: "",
					commit: "",
				})),
			};
			keys.set(request.idempotencyKey, swarm);
			state.swarms.set(id, swarm);
			return { swarm: view(swarm) };
		},
		GetSwarm: (body) => {
			const swarm = state.swarms.get(String(body.swarmId));
			if (!swarm) return { __status: 404, code: "not_found", message: "no such swarm" };
			return { swarm: view(swarm), tasks: swarm.tasks };
		},
		ListSwarms: () => ({ swarms: [...state.swarms.values()].map(view) }),
		CancelSwarm: (body) => {
			const swarm = state.swarms.get(String(body.swarmId));
			if (!swarm) return { __status: 404, code: "not_found", message: "no such swarm" };
			swarm.state = "SWARM_STATE_CANCELLED";
			for (const task of swarm.tasks) {
				if (!TERMINAL.includes(task.state as TaskState)) task.state = "TASK_STATE_CANCELLED";
			}
			return { swarm: view(swarm) };
		},
		ClaimAttempt: (body) => {
			for (const swarm of state.swarms.values()) {
				if (body.swarmId && swarm.id !== body.swarmId) continue;
				if (swarm.state !== "SWARM_STATE_RUNNING") continue;
				const task = swarm.tasks.find((t) => t.state === "TASK_STATE_QUEUED");
				if (!task) continue;
				const number = task.attempts.length + 1;
				const attempt: Attempt = {
					id: `${task.id}-a${number}`,
					number,
					workerId: String(body.workerId),
					runId: `run-${task.id}-a${number}`,
				};
				task.attempts.push(attempt);
				task.state = "TASK_STATE_RUNNING";
				emit(swarm.id, "attempt.started", `attempt ${number}`, task.id);
				return {
					assignment: {
						swarmId: swarm.id,
						taskId: task.id,
						attemptId: attempt.id,
						attemptNumber: number,
						runId: attempt.runId,
						title: task.title,
						prompt: task.prompt,
						feedback: task.feedback,
						repo: swarm.request.repo,
						baseRef: swarm.request.baseRef,
						model: swarm.request.model,
						leaseSeconds: 60,
						branch: task.branch,
					},
				};
			}
			return {};
		},
		Heartbeat: (body) => {
			state.heartbeats++;
			const found = findAttempt(String(body.attemptId));
			if (found?.swarm.state === "SWARM_STATE_CANCELLED") return { leaseHeld: false, cancelled: true };
			return state.heartbeat(state.heartbeats);
		},
		CompleteAttempt: (body) => {
			const completion = body as unknown as CompleteAttemptRequest;
			state.completions.push(completion);
			const found = findAttempt(completion.attemptId);
			if (!found) return { __status: 404, code: "not_found", message: "no such attempt" };
			const { task, attempt, swarm } = found;
			const verdict = state.decide(completion, task, attempt);
			attempt.decision = verdict.decision;
			attempt.exitCode = completion.exitCode;
			attempt.commit = completion.commit;
			attempt.branch = completion.branch;
			task.branch = completion.branch || task.branch;
			task.commit = completion.commit;
			if (verdict.decision === "GATE_DECISION_PASS") task.state = "TASK_STATE_PASSED";
			else if (verdict.decision === "GATE_DECISION_RETRY") {
				task.state = "TASK_STATE_QUEUED";
				task.feedback = verdict.reason ?? "";
			} else if (verdict.decision === "GATE_DECISION_BLOCK") task.state = "TASK_STATE_BLOCKED";
			else task.state = "TASK_STATE_FAILED";
			emit(swarm.id, "attempt.gated", verdict.decision, task.id);
			refresh(swarm);
			return { decision: verdict.decision, reason: verdict.reason ?? "" };
		},
		ClaimMerge: (body) => {
			const swarm = state.swarms.get(String(body.swarmId));
			if (!swarm) return { __status: 404, code: "not_found", message: "no such swarm" };
			refresh(swarm);
			if (swarm.state !== "SWARM_STATE_RUNNING") return { swarmFinished: true };
			const task = swarm.tasks.find(
				(t) => t.state === "TASK_STATE_PASSED" || t.state === "TASK_STATE_MERGING",
			);
			if (!task) return {};
			task.state = "TASK_STATE_MERGING";
			return {
				job: {
					swarmId: swarm.id,
					taskId: task.id,
					branch: task.branch,
					commit: task.commit,
					title: task.title,
				},
			};
		},
		FinishMerge: (body) => {
			const found = find(String(body.taskId));
			if (!found) return { __status: 404, code: "not_found", message: "no such task" };
			found.task.state = body.merged ? "TASK_STATE_MERGED" : "TASK_STATE_CONFLICT";
			found.task.detail = String(body.detail ?? "");
			emit(found.swarm.id, "task.merge", body.merged ? "merged" : String(body.detail), found.task.id);
			refresh(found.swarm);
			return { task: found.task };
		},
		RecordTurn: (body) => {
			state.turns.push(body as unknown as RecordTurnRequest);
			return { duplicate: false };
		},
	};

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(": hello\n\n");
			for (const event of history) res.write(`data: ${JSON.stringify(event)}\n\n`);
			streams.add(res);
			req.on("close", () => streams.delete(res));
			return;
		}
		const method = url.pathname.split("/").at(-1) ?? "";
		const handler = handlers[method];
		if (req.method !== "POST" || !handler)
			return send(res, { code: "unimplemented", message: url.pathname }, 404);
		const result = handler(await readJson(req)) as { __status?: number; code?: string; message?: string };
		if (result.__status) return send(res, { code: result.code, message: result.message }, result.__status);
		send(res, result);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	state.close = () =>
		new Promise<void>((resolve) => {
			for (const stream of streams) stream.end();
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return state;
}

export async function until(check: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

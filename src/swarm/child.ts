import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ChildRequest {
	cwd: string;
	prompt: string;
	runId: string;
	provider: string;
	model: string;
	server: string;
}

export interface ChildCommand {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

export type Launcher = (request: ChildRequest) => ChildCommand;

export interface ChildResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ChildHandle {
	done: Promise<ChildResult>;
	stop(): Promise<void>;
}

const TAIL = 4000;

export function entryPoint(dir = import.meta.dirname): { file: string; execArgv: string[] } {
	const source = join(dir, "..", "index.ts");
	if (existsSync(source)) return { file: source, execArgv: ["--import", import.meta.resolve("tsx")] };
	return { file: join(dir, "..", "index.js"), execArgv: [] };
}

export const ledgerLauncher: Launcher = (request) => {
	const entry = entryPoint();
	return {
		command: process.execPath,
		args: [
			...entry.execArgv,
			entry.file,
			"--print",
			"--yes",
			"--validate",
			"strict",
			"--claims",
			"prose",
			"--provider",
			request.provider,
			"--model",
			request.model,
			"--session",
			request.runId,
			request.prompt,
		],
		env: { ...process.env, LEDGER_SERVER: request.server, LEDGER_RUN_ID: request.runId },
	};
};

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

export function startChild(spec: ChildCommand, cwd: string, graceMs = 5000): ChildHandle {
	const child = spawn(spec.command, spec.args, {
		cwd,
		env: spec.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let stdout = "";
	let stderr = "";
	let finished = false;
	child.stdout.on("data", (d: Buffer) => {
		stdout = (stdout + d.toString()).slice(-TAIL);
	});
	child.stderr.on("data", (d: Buffer) => {
		stderr = (stderr + d.toString()).slice(-TAIL);
	});
	const done = new Promise<ChildResult>((resolve) => {
		child.on("error", (err) => {
			finished = true;
			resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` });
		});
		child.on("close", (code, signal) => {
			finished = true;
			const exit = code ?? (signal === "SIGKILL" ? 137 : 143);
			resolve({ code: exit, stdout, stderr });
		});
	});
	const stop = async () => {
		if (finished) return;
		signalGroup(child.pid, "SIGTERM");
		const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), graceMs);
		await done;
		clearTimeout(timer);
	};
	return { done, stop };
}

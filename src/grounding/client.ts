import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { consola } from "consola";
import type { CheckRequest, CheckResponse } from "./types.js";

const BIN_DIR = join(import.meta.dirname, "..", "..", "bin");

export function checkerPath(): string {
	if (process.env.LEDGER_CHECKER_PATH) return process.env.LEDGER_CHECKER_PATH;
	const ext = process.platform === "win32" ? ".exe" : "";
	const local = join(BIN_DIR, `grounding-checker${ext}`);
	return existsSync(local)
		? local
		: join(BIN_DIR, `grounding-checker-${process.platform}-${process.arch}${ext}`);
}

type CheckerProcess = ChildProcessByStdio<Writable, Readable, Readable>;

const failed = (request_id: string, error: string): CheckResponse => ({ request_id, claims: [], error });

export class GroundingClient {
	private child: CheckerProcess | null = null;
	private queue: Array<(result: CheckResponse) => void> = [];
	private nextId = 0;

	private ensureStarted(): CheckerProcess {
		if (this.child) return this.child;

		const child = spawn(checkerPath(), [], { stdio: ["pipe", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let stderrTail = "";
		child.stderr.on("data", (d: Buffer) => {
			stderrTail = (stderrTail + d.toString()).slice(-2000);
		});

		rl.on("line", (line) => {
			const resolve = this.queue.shift();
			if (!resolve) return;
			try {
				resolve(JSON.parse(line) as CheckResponse);
			} catch {
				consola.warn(`grounding checker returned invalid JSON: ${line}`);
				resolve(failed("invalid", "invalid JSON from checker"));
			}
		});
		const reset = (reason: string) => {
			if (this.child === child) this.child = null;
			const pending = this.queue;
			this.queue = [];
			for (const resolve of pending) resolve(failed("unavailable", reason));
		};
		child.on("error", (err) => {
			consola.warn(`grounding checker unavailable: ${err.message}`);
			reset(err.message);
		});
		child.on("exit", () => {
			const detail = stderrTail.trim().split("\n").at(-1);
			reset(detail ? `checker subprocess exited: ${detail}` : "checker subprocess exited");
		});
		child.stdin.on("error", () => {});

		this.child = child;
		return child;
	}

	async check(req: Omit<CheckRequest, "request_id">): Promise<CheckResponse> {
		const request_id = String(this.nextId++);
		try {
			const child = this.ensureStarted();
			return await new Promise((resolve) => {
				this.queue.push(resolve);
				child.stdin.write(`${JSON.stringify({ ...req, request_id })}\n`, (err) => {
					if (!err) return;
					this.queue = this.queue.filter((r) => r !== resolve);
					resolve(failed(request_id, err.message));
				});
			});
		} catch (err) {
			return failed(request_id, err instanceof Error ? err.message : String(err));
		}
	}

	close(): void {
		this.child?.kill();
		this.child = null;
	}
}

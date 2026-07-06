import { type ChildProcessByStdio, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { consola } from "consola";
import type { CheckRequest, VerifiedResult } from "./types.js";

const CHECKER_PATH = join(import.meta.dirname, "..", "..", "bin", "grounding-checker");

type CheckerProcess = ChildProcessByStdio<Writable, Readable, null>;

export class GroundingClient {
	private child: CheckerProcess | null = null;
	private queue: Array<(result: VerifiedResult) => void> = [];
	private nextId = 0;

	private ensureStarted(): CheckerProcess {
		if (this.child) return this.child;

		const child = spawn(CHECKER_PATH, [], { stdio: ["pipe", "pipe", "inherit"] });
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			const resolve = this.queue.shift();
			if (resolve) resolve(JSON.parse(line) as VerifiedResult);
		});
		child.on("exit", () => {
			this.child = null; // let ensureStarted respawn on the next call
		});

		this.child = child;
		return child;
	}

	async check(req: Omit<CheckRequest, "request_id">): Promise<VerifiedResult> {
		try {
			const child = this.ensureStarted();
			const request_id = String(this.nextId++);
			const full: CheckRequest = { ...req, request_id };

			return await new Promise((resolve) => {
				this.queue.push(resolve);
				child.stdin.write(`${JSON.stringify(full)}\n`);
			});
		} catch (err) {
			// a dead or missing checker binary should degrade, never take the agent down
			consola.warn(`grounding checker unavailable: ${err instanceof Error ? err.message : err}`);
			return {
				...req,
				request_id: "unavailable",
				claim_check: { model_claimed: req.model_claimed, matches_evidence: "unverifiable" },
			};
		}
	}
}

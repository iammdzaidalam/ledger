import { spawn } from "node:child_process";

export const MAX_OUTPUT_CHARS = 20_000;

export interface ProcessOutcome {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	executed: boolean;
	timedOut: boolean;
	cancelled?: boolean;
	error?: Error;
}

export interface ProcessOptions {
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessOutcome> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (outcome: Omit<ProcessOutcome, "stdout" | "stderr">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ stdout: truncate(stdout), stderr: truncate(stderr), ...outcome });
		};

		let child: ReturnType<typeof spawn> | undefined;
		const onAbort = () => {
			child?.kill();
			finish({ exitCode: null, executed: child !== undefined, timedOut: false, cancelled: true });
		};
		if (options.signal?.aborted) {
			finish({ exitCode: null, executed: false, timedOut: false, cancelled: true });
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			child = spawn(file, args, { cwd: process.cwd(), env: options.env ?? process.env });
		} catch (err) {
			finish({ exitCode: null, executed: false, timedOut: false, error: asError(err) });
			return;
		}

		const proc = child;
		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		timer = setTimeout(() => {
			proc.kill();
			finish({ exitCode: null, executed: true, timedOut: true });
		}, options.timeoutMs);

		proc.on("error", (err) => finish({ exitCode: null, executed: false, timedOut: false, error: err }));
		proc.on("close", (code) => finish({ exitCode: code, executed: true, timedOut: false }));
	});
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

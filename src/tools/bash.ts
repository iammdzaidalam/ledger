import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;
const DANGEROUS_PATTERNS = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=.*of=\/dev/];

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}

export const bashTool: Tool = {
	name: "Bash",
	description:
		"Run a shell command and get back stdout + stderr combined. Runs in the current " +
		"working directory. Timeout: 30 seconds. Avoid interactive commands.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "The shell command to run" },
			timeout_ms: { type: "number", description: "Timeout in ms, default 30000" },
		},
		required: ["command"],
	},

	async execute(input, meta): Promise<ReturnType<typeof okResult>> {
		const command = input.command as string;
		if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
			return errorResult("Command rejected: matches a destructive pattern");
		}

		const startedAt = Date.now();

		try {
			const isWindows = process.platform === "win32";
			const shell = isWindows ? "cmd.exe" : "/bin/sh";
			const shellArgs = isWindows ? ["/c", command] : ["-c", command];
			const timeoutMs = (input.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;

			const child = spawn(shell, shellArgs, { cwd: process.cwd(), env: process.env });

			return await new Promise((resolve) => {
				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (d: Buffer) => {
					stdout += d.toString();
				});
				child.stderr?.on("data", (d: Buffer) => {
					stderr += d.toString();
				});

				const timer = setTimeout(() => {
					child.kill();
					meta?.onExecution?.({
						args: input,
						raw_stdout: truncate(stdout),
						raw_stderr: truncate(stderr),
						exit_code: null,
						executed: true,
						duration_ms: Date.now() - startedAt,
					});
					resolve(errorResult(`Command timed out after ${timeoutMs}ms`));
				}, timeoutMs);

				// spawn itself failed - the command never actually ran
				child.on("error", (err) => {
					clearTimeout(timer);
					meta?.onExecution?.({
						args: input,
						raw_stdout: "",
						raw_stderr: "",
						exit_code: null,
						executed: false,
						duration_ms: Date.now() - startedAt,
					});
					resolve(errorResult(err));
				});

				child.on("close", (code) => {
					clearTimeout(timer);
					meta?.onExecution?.({
						args: input,
						raw_stdout: truncate(stdout),
						raw_stderr: truncate(stderr),
						exit_code: code,
						executed: true,
						duration_ms: Date.now() - startedAt,
					});
					const combined = truncate(stdout + stderr);
					if (code !== 0) resolve(errorResult(`Exit ${code}:\n${combined}`));
					else resolve(okResult(combined || "(no output)"));
				});
			});
		} catch (err) {
			meta?.onExecution?.({
				args: input,
				raw_stdout: "",
				raw_stderr: "",
				exit_code: null,
				executed: false,
				duration_ms: Date.now() - startedAt,
			});
			return errorResult(err);
		}
	},
};

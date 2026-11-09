import { runProcess, truncate } from "./process.js";
import type { Tool, ToolResult } from "./types.js";
import { errorResult, okResult } from "./types.js";
import { shellCommand } from "./workspace.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DANGEROUS_PATTERNS = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=.*of=\/dev/];

export const bashTool: Tool = {
	name: "Bash",
	evidence: { tool: "Bash", args: (input) => input },
	description:
		"Run a shell command and get back stdout + stderr combined. Runs in the current " +
		"working directory. Timeout: 30 seconds. Avoid interactive commands.",
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "The shell command to run" },
			timeout_ms: { type: "number", description: "Timeout in ms, default 30000, max 120000" },
		},
		required: ["command"],
	},

	async execute(input, meta): Promise<ToolResult> {
		const command = input.command as string;
		if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
			return errorResult("Command rejected: matches a destructive pattern");
		}

		const startedAt = Date.now();
		const timeoutMs = Math.min(
			(input.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
		);
		const shell = shellCommand(command);
		const out = await runProcess(shell.file, shell.args, { timeoutMs, signal: meta?.signal });

		meta?.onExecution?.({
			args: input,
			raw_stdout: out.stdout,
			raw_stderr: out.cancelled ? `${out.stderr}\n[cancelled by the user]`.trimStart() : out.stderr,
			exit_code: out.exitCode,
			executed: out.executed,
			is_error: out.timedOut || !out.executed || out.exitCode !== 0,
			duration_ms: Date.now() - startedAt,
		});

		if (out.error) return errorResult(out.error);
		if (out.cancelled) return errorResult("Cancelled by the user before it finished");
		if (out.timedOut) return errorResult(`Command timed out after ${timeoutMs}ms`);
		const combined = truncate(out.stdout + out.stderr);
		if (out.exitCode !== 0) return errorResult(`Exit ${out.exitCode}:\n${combined}`);
		return okResult(combined || "(no output)");
	},
};

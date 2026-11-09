import { runProcess, truncate } from "./process.js";
import type { RawExecution, Tool, ToolExecMeta, ToolResult } from "./types.js";
import { errorResult, okResult } from "./types.js";
import { outsideWorkspace, sandboxed } from "./workspace.js";

const TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 100;

type Input = Record<string, unknown>;
type Plan = { args: string[]; error?: string };
type RunResult = Omit<RawExecution, "args" | "duration_ms">;

interface GitToolSpec {
	name: string;
	description: string;
	properties: Record<string, unknown>;
	required?: string[];
	readOnly?: boolean;
	plan(input: Input): Plan;
}

export function quoteArg(arg: string): string {
	return /^[\w@%+=:,./~^-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function gitCommandLine(args: string[]): string {
	return ["git", ...args].map(quoteArg).join(" ");
}

function evidenceArgs(name: string, args: string[]): Record<string, unknown> {
	return { command: gitCommandLine(args), via: name };
}

function str(input: Input, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function strings(input: Input, key: string): string[] {
	const value = input[key];
	if (typeof value === "string") return value.trim() ? [value] : [];
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		: [];
}

function badRef(ref: string | undefined): string | undefined {
	if (ref === undefined) return undefined;
	if (ref.startsWith("-") || /[\s\0]/.test(ref)) return `invalid ref: ${ref}`;
	return undefined;
}

function compact(args: Array<string | false | undefined>): string[] {
	return args.filter((a): a is string => typeof a === "string");
}

function pathsAfterDashes(paths: string[]): string[] {
	return paths.length > 0 ? ["--", ...paths] : [];
}

function workspaceError(paths: string[]): string | undefined {
	const outside = paths.find((p) => outsideWorkspace(p));
	return outside ? `${outside} is outside the workspace` : undefined;
}

async function runGit(
	args: string[],
	readOnly: boolean,
	signal?: AbortSignal,
): Promise<{ result: ToolResult; exec: RunResult }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_EDITOR: "true",
		GIT_PAGER: "cat",
		...(readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
	};
	const cmd = sandboxed("git", args);
	const out = await runProcess(cmd.file, cmd.args, { timeoutMs: TIMEOUT_MS, env, signal });
	const exec: RunResult = {
		raw_stdout: out.stdout,
		raw_stderr: out.stderr,
		exit_code: out.exitCode,
		executed: out.executed,
		is_error: out.timedOut || !out.executed || out.exitCode !== 0,
	};
	if (out.error) return { result: errorResult(out.error), exec };
	if (out.timedOut) return { result: errorResult(`git timed out after ${TIMEOUT_MS}ms`), exec };
	const combined = truncate(out.stdout + out.stderr);
	if (out.exitCode !== 0) return { result: errorResult(`Exit ${out.exitCode}:\n${combined}`), exec };
	return { result: okResult(combined || "(no output)"), exec };
}

function gitTool(spec: GitToolSpec): Tool {
	return {
		name: spec.name,
		description: spec.description,
		readOnly: spec.readOnly,
		inputSchema: { type: "object", properties: spec.properties, required: spec.required ?? [] },
		evidence: { tool: "Git", args: (input) => evidenceArgs(spec.name, spec.plan(input).args) },

		async execute(input: Input, meta?: ToolExecMeta): Promise<ToolResult> {
			const startedAt = Date.now();
			const plan = spec.plan(input);
			const args = evidenceArgs(spec.name, plan.args);
			if (plan.error) {
				meta?.onExecution?.({
					args,
					raw_stdout: "",
					raw_stderr: plan.error,
					exit_code: null,
					executed: false,
					is_error: true,
					duration_ms: 0,
				});
				return errorResult(plan.error);
			}
			const { result, exec } = await runGit(plan.args, spec.readOnly === true, meta?.signal);
			meta?.onExecution?.({ args, duration_ms: Date.now() - startedAt, ...exec });
			return result;
		},
	};
}

export const gitStatusTool = gitTool({
	name: "GitStatus",
	description: "Show the current branch and the staged, unstaged and untracked files (git status --short).",
	properties: {},
	readOnly: true,
	plan: () => ({ args: ["status", "--short", "--branch"] }),
});

export const gitDiffTool = gitTool({
	name: "GitDiff",
	description:
		"Show changes. No arguments: unstaged changes in the working tree. staged: changes in the index. " +
		"base/target: compare commits or branches. paths: limit to files. stat: counts only.",
	properties: {
		staged: { type: "boolean", description: "Diff the index against HEAD" },
		base: { type: "string", description: "Commit or branch to compare from" },
		target: { type: "string", description: "Commit or branch to compare to, needs base" },
		paths: { type: "array", items: { type: "string" }, description: "Limit the diff to these paths" },
		stat: { type: "boolean", description: "Only show per-file counts" },
	},
	readOnly: true,
	plan(input) {
		const base = str(input, "base");
		const target = str(input, "target");
		const args = compact([
			"diff",
			input.staged === true && "--staged",
			input.stat === true && "--stat",
			base,
			target,
			...pathsAfterDashes(strings(input, "paths")),
		]);
		const error = badRef(base) ?? badRef(target) ?? (target && !base ? "target needs base" : undefined);
		return { args, error };
	},
});

export const gitLogTool = gitTool({
	name: "GitLog",
	description: "Show recent commits, one per line: short hash, date, author, subject.",
	properties: {
		limit: { type: "number", description: `How many commits, default 10, max ${MAX_LOG_ENTRIES}` },
		ref: { type: "string", description: "Branch or commit to start from, default HEAD" },
		path: { type: "string", description: "Only commits touching this path" },
		author: { type: "string", description: "Only commits by this author" },
	},
	readOnly: true,
	plan(input) {
		const requested = typeof input.limit === "number" ? Math.floor(input.limit) : 10;
		const limit = Math.min(Math.max(requested, 1), MAX_LOG_ENTRIES);
		const ref = str(input, "ref");
		const author = str(input, "author");
		const path = str(input, "path");
		const args = compact([
			"log",
			`-n${limit}`,
			"--date=short",
			"--format=%h %ad %an  %s",
			author && `--author=${author}`,
			ref,
			...pathsAfterDashes(path ? [path] : []),
		]);
		return { args, error: badRef(ref) };
	},
});

export const gitShowTool = gitTool({
	name: "GitShow",
	description: "Show one commit: message and patch, or only per-file counts with stat.",
	properties: {
		ref: { type: "string", description: "Commit to show, default HEAD" },
		stat: { type: "boolean", description: "Only show per-file counts" },
		path: { type: "string", description: "Limit the patch to this path" },
	},
	readOnly: true,
	plan(input) {
		const ref = str(input, "ref") ?? "HEAD";
		const path = str(input, "path");
		const args = compact([
			"show",
			input.stat === true && "--stat",
			ref,
			...pathsAfterDashes(path ? [path] : []),
		]);
		return { args, error: badRef(ref) };
	},
});

export const gitBranchTool = gitTool({
	name: "GitBranch",
	description: "List branches, marking the current one. all: include remote-tracking branches.",
	properties: { all: { type: "boolean", description: "Include remote-tracking branches" } },
	readOnly: true,
	plan: (input) => ({ args: compact(["branch", "--list", "-v", input.all === true && "--all"]) }),
});

export const gitAddTool = gitTool({
	name: "GitAdd",
	description: "Stage files for the next commit. Use paths: ['.'] to stage everything.",
	properties: {
		paths: { type: "array", items: { type: "string" }, description: "Files or directories to stage" },
	},
	required: ["paths"],
	plan(input) {
		const paths = strings(input, "paths");
		const error = paths.length === 0 ? "paths is required" : workspaceError(paths);
		return { args: ["add", ...pathsAfterDashes(paths)], error };
	},
});

export const gitCommitTool = gitTool({
	name: "GitCommit",
	description: "Commit what is staged, with a message. Stage files with GitAdd first.",
	properties: {
		message: { type: "string", description: "Commit message" },
		amend: { type: "boolean", description: "Replace the previous commit instead" },
	},
	required: ["message"],
	plan(input) {
		const message = str(input, "message");
		const args = compact(["commit", "-m", message ?? "", input.amend === true && "--amend"]);
		return { args, error: message ? undefined : "message is required" };
	},
});

export const gitCheckoutTool = gitTool({
	name: "GitCheckout",
	description:
		"Switch to a branch (create: make it first), or restore paths from HEAD, which throws away " +
		"their uncommitted changes. Give branch or paths, not both.",
	properties: {
		branch: { type: "string", description: "Branch to switch to" },
		create: { type: "boolean", description: "Create the branch first" },
		paths: { type: "array", items: { type: "string" }, description: "Files to restore from HEAD" },
	},
	plan(input) {
		const branch = str(input, "branch");
		const paths = strings(input, "paths");
		if (branch && paths.length > 0) return { args: ["checkout"], error: "give branch or paths, not both" };
		if (paths.length > 0) return { args: ["checkout", "--", ...paths], error: workspaceError(paths) };
		if (!branch) return { args: ["switch"], error: "branch or paths is required" };
		return { args: compact(["switch", input.create === true && "-c", branch]), error: badRef(branch) };
	},
});

export const GIT_TOOLS: Tool[] = [
	gitStatusTool,
	gitDiffTool,
	gitLogTool,
	gitShowTool,
	gitBranchTool,
	gitAddTool,
	gitCommitTool,
	gitCheckoutTool,
];

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import {
	GIT_TOOLS,
	gitAddTool,
	gitBranchTool,
	gitCheckoutTool,
	gitCommitTool,
	gitDiffTool,
	gitLogTool,
	gitShowTool,
	gitStatusTool,
	quoteArg,
} from "../src/tools/git.js";
import type { RawExecution, Tool } from "../src/tools/types.js";

describe("git tools", () => {
	let repo: string;
	let home: string;
	let client: GroundingClient;

	const run = async (tool: Tool, input: Record<string, unknown>, log?: EvidenceLog) => {
		let exec: RawExecution | undefined;
		const result = await tool.execute(input, {
			onExecution: (e) => {
				exec = e;
				if (log && tool.evidence) log.record(tool.evidence.tool, e);
			},
		});
		return { result, exec: exec as RawExecution };
	};

	beforeAll(async () => {
		home = process.cwd();
		repo = await realpath(await mkdtemp(join(tmpdir(), "ledger-git-")));
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Ledger Test"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
		await writeFile(join(repo, "a.txt"), "one\n");
		process.chdir(repo);
		client = new GroundingClient();
	});

	afterAll(async () => {
		client.close();
		process.chdir(home);
		delete process.env.LEDGER_WORKSPACE;
		await rm(repo, { recursive: true, force: true });
	});

	it("marks only the inspecting tools read-only", () => {
		const readOnly = GIT_TOOLS.filter((t) => t.readOnly).map((t) => t.name);
		expect(readOnly).toEqual(["GitStatus", "GitDiff", "GitLog", "GitShow", "GitBranch"]);
		expect(GIT_TOOLS.every((t) => t.evidence?.tool === "Git")).toBe(true);
	});

	it("records status as a Git evidence entry with the command line", async () => {
		const { result, exec } = await run(gitStatusTool, {});
		expect(result.output).toContain("?? a.txt");
		expect(exec).toMatchObject({
			args: { command: "git status --short --branch", via: "GitStatus" },
			exit_code: 0,
			executed: true,
			is_error: false,
		});
	});

	it("stages and commits, and the commit shows in log and show", async () => {
		expect((await run(gitAddTool, { paths: ["a.txt"] })).exec.exit_code).toBe(0);
		const commit = await run(gitCommitTool, { message: "add a's file" });
		expect(commit.exec).toMatchObject({
			args: { command: "git commit -m 'add a'\\''s file'" },
			exit_code: 0,
		});

		const log = await run(gitLogTool, { limit: 5 });
		expect(log.result.output).toContain("add a's file");
		const show = await run(gitShowTool, { stat: true });
		expect(show.result.output).toContain("a.txt");
	});

	it("lets the checker contradict 'committed' when the commit failed", async () => {
		const log = new EvidenceLog();
		const { exec } = await run(gitCommitTool, { message: "nothing staged" }, log);
		expect(exec).toMatchObject({ exit_code: 1, executed: true, is_error: true });
		const res = await client.check({
			turn_text: "Ran `git commit` and it succeeded.",
			evidence: log.all(),
			fresh_refs: log.takeFresh(),
		});
		expect(res.claims[0]).toMatchObject({ kind: "command_success", verdict: "contradicted", ref: "c1" });
		expect(res.claims[0]?.reason).toContain("git commit -m");
	});

	it("diffs the working tree and restores a path with GitCheckout", async () => {
		await writeFile(join(repo, "a.txt"), "changed\n");
		const diff = await run(gitDiffTool, {});
		expect(diff.result.output).toContain("+changed");
		const stat = await run(gitDiffTool, { stat: true, paths: ["a.txt"] });
		expect(stat.exec.args.command).toBe("git diff --stat -- a.txt");

		await run(gitCheckoutTool, { paths: ["a.txt"] });
		expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("one\n");
	});

	it("creates and switches branches, and lists them", async () => {
		const sw = await run(gitCheckoutTool, { branch: "feature/x", create: true });
		expect(sw.exec).toMatchObject({ args: { command: "git switch -c feature/x" }, exit_code: 0 });
		const branches = await run(gitBranchTool, {});
		expect(branches.result.output).toMatch(/\* feature\/x/);
		expect(branches.result.output).toContain("main");
	});

	it("rejects refs that look like options without running git", async () => {
		const { result, exec } = await run(gitDiffTool, { base: "--output=/tmp/pwned" });
		expect(result.isError).toBe(true);
		expect(exec).toMatchObject({ executed: false, exit_code: null });
		expect((await run(gitLogTool, { ref: "-p" })).exec.executed).toBe(false);
		expect((await run(gitCheckoutTool, { branch: "main", paths: ["a.txt"] })).exec.executed).toBe(false);
		expect((await run(gitCommitTool, { message: "  " })).result.output).toContain("message is required");
	});

	it("refuses to stage paths outside LEDGER_WORKSPACE", async () => {
		process.env.LEDGER_WORKSPACE = join(repo, "sub");
		const { result, exec } = await run(gitAddTool, { paths: ["a.txt"] });
		delete process.env.LEDGER_WORKSPACE;
		expect(result.output).toContain("outside the workspace");
		expect(exec.executed).toBe(false);
	});

	it("quotes arguments the way a shell would read them", () => {
		expect(quoteArg("HEAD~1")).toBe("HEAD~1");
		expect(quoteArg("fix the bug")).toBe("'fix the bug'");
		expect(quoteArg("it's")).toBe("'it'\\''s'");
	});
});

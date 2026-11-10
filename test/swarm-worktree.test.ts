import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addIntegration,
	addTaskWorktree,
	changedFiles,
	commitAll,
	excludeFleet,
	git,
	integrationBranch,
	mergeInto,
	removeFleet,
	resolveCommit,
	taskBranch,
	taskPath,
} from "../src/swarm/worktree.js";
import { makeRepo, sh } from "./fleet-support.js";

const repos: string[] = [];
const repo = (files?: Record<string, string>) => {
	const dir = makeRepo(files);
	repos.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worktrees", () => {
	it("creates a worktree on a task branch from the base commit", async () => {
		const dir = repo();
		const base = await resolveCommit(dir, "HEAD");
		const checkout = await addTaskWorktree(dir, "s1", 0, base);
		expect(checkout.path).toBe(taskPath(dir, "s1", 0));
		expect(checkout.branch).toBe("ledger/s1/0");
		expect(sh(checkout.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ledger/s1/0");
		expect(sh(checkout.path, "rev-parse", "HEAD")).toBe(base);
	});

	it("reuses the worktree and keeps the earlier commit on a second call", async () => {
		const dir = repo();
		const base = await resolveCommit(dir, "HEAD");
		const first = await addTaskWorktree(dir, "s1", 0, base);
		writeFileSync(join(first.path, "new.txt"), "x\n");
		const commit = await commitAll(first.path, "first try");
		const second = await addTaskWorktree(dir, "s1", 0, base);
		expect(second.path).toBe(first.path);
		expect(sh(second.path, "rev-parse", "HEAD")).toBe(commit);
	});

	it("re-attaches the branch when the directory is gone", async () => {
		const dir = repo();
		const base = await resolveCommit(dir, "HEAD");
		const first = await addTaskWorktree(dir, "s1", 0, base);
		writeFileSync(join(first.path, "new.txt"), "x\n");
		const commit = await commitAll(first.path, "first try");
		rmSync(first.path, { recursive: true, force: true });
		const again = await addTaskWorktree(dir, "s1", 0, base);
		expect(sh(again.path, "rev-parse", "HEAD")).toBe(commit);
		expect(readFileSync(join(again.path, "new.txt"), "utf-8")).toBe("x\n");
	});

	it("commits everything, lists changed files, and leaves ledger session files out", async () => {
		const dir = repo();
		const base = await resolveCommit(dir, "HEAD");
		const { path } = await addTaskWorktree(dir, "s1", 1, base);
		writeFileSync(join(path, "a.txt"), "changed\n");
		writeFileSync(join(path, "fresh.txt"), "fresh\n");
		mkdirSync(join(path, ".ledger", "sessions"), { recursive: true });
		writeFileSync(join(path, ".ledger", "sessions", "run.jsonl"), "{}\n");
		const commit = await commitAll(path, "ledger: task");
		expect(commit).not.toBe(base);
		expect((await changedFiles(path, base)).sort()).toEqual(["a.txt", "fresh.txt"]);
		expect(sh(path, "ls-files", ".ledger")).toBe("");
		expect(sh(path, "log", "-1", "--format=%s")).toBe("ledger: task");
	});

	it("does not create an empty commit when nothing changed", async () => {
		const dir = repo();
		const base = await resolveCommit(dir, "HEAD");
		const { path } = await addTaskWorktree(dir, "s1", 0, base);
		expect(await commitAll(path, "nothing")).toBe(base);
	});

	it("ignores the fleet directory through info/exclude, not .gitignore", async () => {
		const dir = repo();
		await excludeFleet(dir);
		await excludeFleet(dir);
		await addTaskWorktree(dir, "s1", 0, await resolveCommit(dir, "HEAD"));
		expect(sh(dir, "status", "--porcelain")).toBe("");
		const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
		expect(exclude.split("\n").filter((line) => line === ".ledger/fleet/")).toHaveLength(1);
		expect(existsSync(join(dir, ".gitignore"))).toBe(false);
	});

	it("removes every worktree of a swarm and keeps the branches", async () => {
		const dir = repo();
		const base = await resolveCommit(dir, "HEAD");
		await addTaskWorktree(dir, "s1", 0, base);
		await addTaskWorktree(dir, "s1", 1, base);
		await addIntegration(dir, "s1", base);
		await removeFleet(dir, "s1");
		expect(existsSync(join(dir, ".ledger", "fleet", "s1"))).toBe(false);
		expect(sh(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(sh(dir, "branch", "--list", "ledger/s1/*").split("\n")).toHaveLength(3);
	});
});

describe("integration branch", () => {
	async function task(dir: string, index: number, files: Record<string, string>) {
		const base = await resolveCommit(dir, "main");
		const { path } = await addTaskWorktree(dir, "s1", index, base);
		for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
		return commitAll(path, `task ${index}`);
	}

	it("merges passed branches with merge commits and never touches the user's checkout", async () => {
		const dir = repo();
		await excludeFleet(dir);
		const before = { head: sh(dir, "rev-parse", "HEAD"), branch: sh(dir, "branch", "--show-current") };
		const one = await task(dir, 0, { "a.txt": "from zero\n" });
		const two = await task(dir, 1, { "b.txt": "from one\n" });
		const integration = await addIntegration(dir, "s1", await resolveCommit(dir, "main"));
		expect(integration.branch).toBe(integrationBranch("s1"));

		expect((await mergeInto(integration.path, one, "Merge zero")).merged).toBe(true);
		expect((await mergeInto(integration.path, two, "Merge one")).merged).toBe(true);

		expect(readFileSync(join(integration.path, "a.txt"), "utf-8")).toBe("from zero\n");
		expect(readFileSync(join(integration.path, "b.txt"), "utf-8")).toBe("from one\n");
		expect(sh(integration.path, "log", "--merges", "--format=%s")).toBe("Merge one\nMerge zero");
		expect(sh(dir, "rev-parse", "HEAD")).toBe(before.head);
		expect(sh(dir, "branch", "--show-current")).toBe(before.branch);
		expect(sh(dir, "status", "--porcelain")).toBe("");
		expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("a\n");
	});

	it("treats a branch that is already merged as merged", async () => {
		const dir = repo();
		const one = await task(dir, 0, { "a.txt": "from zero\n" });
		const integration = await addIntegration(dir, "s1", await resolveCommit(dir, "main"));
		await mergeInto(integration.path, one, "Merge zero");
		const again = await mergeInto(integration.path, one, "Merge zero");
		expect(again.merged).toBe(true);
	});

	it("aborts a conflicting merge and leaves the integration worktree clean", async () => {
		const dir = repo();
		const one = await task(dir, 0, { "shared.txt": "zero\n" });
		const two = await task(dir, 1, { "shared.txt": "one\n" });
		const integration = await addIntegration(dir, "s1", await resolveCommit(dir, "main"));
		expect((await mergeInto(integration.path, one, "Merge zero")).merged).toBe(true);
		const head = sh(integration.path, "rev-parse", "HEAD");

		const outcome = await mergeInto(integration.path, two, "Merge one");
		expect(outcome).toMatchObject({ merged: false, conflicts: ["shared.txt"] });
		if (!outcome.merged) expect(outcome.detail).toContain("shared.txt");
		expect(sh(integration.path, "status", "--porcelain")).toBe("");
		expect(sh(integration.path, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(join(integration.path, ".git"))).toBe(true);
		expect(readFileSync(join(integration.path, "shared.txt"), "utf-8")).toBe("zero\n");
	});

	it("cleans up a half-finished merge when the worktree is reopened", async () => {
		const dir = repo();
		const one = await task(dir, 0, { "shared.txt": "zero\n" });
		const two = await task(dir, 1, { "shared.txt": "one\n" });
		const base = await resolveCommit(dir, "main");
		const integration = await addIntegration(dir, "s1", base);
		await mergeInto(integration.path, one, "Merge zero");
		await git(integration.path, ["merge", "--no-ff", "--no-commit", two]).catch(() => undefined);
		expect(sh(integration.path, "status", "--porcelain")).not.toBe("");
		const reopened = await addIntegration(dir, "s1", base);
		expect(sh(reopened.path, "status", "--porcelain")).toBe("");
	});

	it("names task branches by swarm and index", () => {
		expect(taskBranch("abc", 2)).toBe("ledger/abc/2");
	});
});

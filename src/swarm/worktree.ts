import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {
	constructor(
		readonly args: string[],
		readonly stderr: string,
	) {
		super(`git ${args.slice(0, 3).join(" ")} failed: ${stderr.trim() || "no output"}`);
		this.name = "GitError";
	}
}

export async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
		return stdout.trim();
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? String(err);
		throw new GitError(args, stderr);
	}
}

let tail: Promise<unknown> = Promise.resolve();

function exclusive<T>(job: () => Promise<T>): Promise<T> {
	const next = tail.then(job, job);
	tail = next.catch(() => undefined);
	return next;
}

export interface Checkout {
	path: string;
	branch: string;
}

export function taskBranch(swarmId: string, index: number): string {
	return `ledger/${swarmId}/${index}`;
}

export function integrationBranch(swarmId: string): string {
	return `ledger/${swarmId}/integration`;
}

export function fleetRoot(repo: string): string {
	return join(repo, ".ledger", "fleet");
}

export function taskPath(repo: string, swarmId: string, index: number): string {
	return join(fleetRoot(repo), swarmId, String(index));
}

export function integrationPath(repo: string, swarmId: string): string {
	return join(fleetRoot(repo), swarmId, "integration");
}

export async function repoRoot(cwd: string): Promise<string> {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
	return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

export async function excludeFleet(repo: string): Promise<void> {
	const file = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
	const entry = ".ledger/fleet/";
	const current = await readFile(file, "utf-8").catch(() => "");
	if (current.split("\n").includes(entry)) return;
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
	try {
		await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

export async function addWorktree(
	repo: string,
	path: string,
	branch: string,
	baseRef: string,
): Promise<Checkout> {
	return exclusive(async () => {
		if (existsSync(join(path, ".git"))) return { path, branch };
		await rm(path, { recursive: true, force: true });
		await git(repo, ["worktree", "prune"]);
		await mkdir(dirname(path), { recursive: true });
		if (await branchExists(repo, branch)) await git(repo, ["worktree", "add", path, branch]);
		else await git(repo, ["worktree", "add", "-b", branch, path, baseRef]);
		return { path, branch };
	});
}

export function addTaskWorktree(
	repo: string,
	swarmId: string,
	index: number,
	baseRef: string,
	branch = taskBranch(swarmId, index),
): Promise<Checkout> {
	return addWorktree(repo, taskPath(repo, swarmId, index), branch, baseRef);
}

export async function headCommit(path: string): Promise<string> {
	return git(path, ["rev-parse", "HEAD"]);
}

function identity(): string[] {
	return ["-c", "user.name=ledger", "-c", "user.email=ledger@localhost", "-c", "commit.gpgsign=false"];
}

async function hasIdentity(path: string): Promise<boolean> {
	const [name, email] = await Promise.all([
		git(path, ["config", "user.name"]).catch(() => ""),
		git(path, ["config", "user.email"]).catch(() => ""),
	]);
	return Boolean(name && email);
}

async function identityFor(path: string): Promise<string[]> {
	return (await hasIdentity(path)) ? ["-c", "commit.gpgsign=false"] : identity();
}

export async function commitAll(path: string, message: string): Promise<string> {
	await git(path, ["add", "-A", "--", ".", ":(exclude).ledger"]);
	const staged = await git(path, ["diff", "--cached", "--name-only"]);
	if (staged) await git(path, [...(await identityFor(path)), "commit", "--no-verify", "-m", message]);
	return headCommit(path);
}

export async function changedFiles(path: string, baseRef: string): Promise<string[]> {
	const out = await git(path, ["diff", "--name-only", baseRef, "HEAD"]);
	return out.split("\n").filter(Boolean);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
	await exclusive(async () => {
		await git(repo, ["worktree", "remove", "--force", path]).catch(() => undefined);
		await rm(path, { recursive: true, force: true });
		await git(repo, ["worktree", "prune"]).catch(() => undefined);
	});
}

export async function removeFleet(repo: string, swarmId: string): Promise<void> {
	const dir = join(fleetRoot(repo), swarmId);
	const entries = await readdir(dir).catch(() => [] as string[]);
	for (const entry of entries) await removeWorktree(repo, join(dir, entry));
	await rm(dir, { recursive: true, force: true });
}

async function resetClean(path: string): Promise<void> {
	await git(path, ["merge", "--abort"]).catch(() => undefined);
	if (await git(path, ["status", "--porcelain"])) {
		await git(path, ["reset", "--hard", "HEAD"]);
		await git(path, ["clean", "-fd"]);
	}
}

export async function addIntegration(repo: string, swarmId: string, baseRef: string): Promise<Checkout> {
	const checkout = await addWorktree(
		repo,
		integrationPath(repo, swarmId),
		integrationBranch(swarmId),
		baseRef,
	);
	await resetClean(checkout.path);
	return checkout;
}

export type MergeOutcome =
	| { merged: true; commit: string }
	| { merged: false; conflicts: string[]; detail: string };

export async function mergeInto(path: string, ref: string, message: string): Promise<MergeOutcome> {
	try {
		await git(path, [...(await identityFor(path)), "merge", "--no-ff", "--no-verify", "-m", message, ref]);
		return { merged: true, commit: await headCommit(path) };
	} catch (err) {
		const conflicts = (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
			.split("\n")
			.filter(Boolean);
		await resetClean(path);
		const detail = conflicts.length > 0 ? `conflict in ${conflicts.join(", ")}` : (err as Error).message;
		return { merged: false, conflicts, detail };
	}
}

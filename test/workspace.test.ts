import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outsideWorkspace, shellCommand } from "../src/tools/workspace.js";
import { writeTool } from "../src/tools/write.js";

describe("LEDGER_WORKSPACE", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ledger-ws-"));
		process.env.LEDGER_WORKSPACE = dir;
	});

	afterEach(async () => {
		delete process.env.LEDGER_WORKSPACE;
		await rm(dir, { recursive: true, force: true });
	});

	it("allows paths inside and refuses paths outside", () => {
		expect(outsideWorkspace(join(dir, "a", "b.txt"))).toBe(false);
		expect(outsideWorkspace(join(dir, "..", "escape.txt"))).toBe(true);
		expect(outsideWorkspace("/etc/hosts")).toBe(true);
	});

	it("makes Write fail outside the workspace and records it as evidence", async () => {
		let isError: boolean | undefined;
		const result = await writeTool.execute(
			{ path: join(dir, "..", "escape.txt"), content: "x" },
			{ onExecution: (e) => (isError = e.is_error) },
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outside the workspace");
		expect(isError).toBe(true);
	});

	it("is a no-op when unset", () => {
		delete process.env.LEDGER_WORKSPACE;
		expect(outsideWorkspace("/etc/hosts")).toBe(false);
		expect(shellCommand("ls").file).toBe(process.platform === "win32" ? "cmd.exe" : "/bin/sh");
	});

	it.runIf(process.platform === "darwin")("wraps bash in sandbox-exec on macOS", () => {
		const { file, args } = shellCommand("ls");
		expect(file).toBe("/usr/bin/sandbox-exec");
		expect(args.join(" ")).toContain(dir);
	});
});

import { mkdir, rmdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lsTool } from "../src/tools/ls.js";

describe("Validation of Reported Bugs", () => {
	it("Bug 13: Ls Tool Crashes on Broken Symlinks", async () => {
		const testDir = join(process.cwd(), ".test-ls-bug");
		try {
			await mkdir(testDir, { recursive: true });
			// Create a broken symlink inside
			await symlink(join(testDir, "nonexistent"), join(testDir, "broken-link"));

			const result = await lsTool.execute({ path: testDir });

			// The bug is that the entire directory listing fails and returns errorResult
			expect(result.isError).toBe(true);
			expect(result.output).toContain("no such file or directory");
		} finally {
			try {
				await unlink(join(testDir, "broken-link"));
			} catch {}
			try {
				await rmdir(testDir);
			} catch {}
		}
	});
});

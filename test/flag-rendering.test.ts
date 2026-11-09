import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import { feedbackFor, formatFlag } from "../src/grounding/format.js";
import { bashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import type { RawExecution } from "../src/tools/types.js";
import { writeTool } from "../src/tools/write.js";

describe("tool evidence -> grounding checker -> terminal flag", () => {
	let dir: string;
	let client: GroundingClient;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "ledger-flag-"));
		client = new GroundingClient();
	});

	afterAll(async () => {
		client.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("flags a model claiming success on a command that actually failed", async () => {
		let captured: RawExecution | undefined;
		await bashTool.execute({ command: "exit 1" }, { onExecution: (exec) => (captured = exec) });
		expect(captured).toMatchObject({ exit_code: 1, executed: true, is_error: true });

		const log = new EvidenceLog();
		log.record("Bash", captured as RawExecution);
		const res = await client.check({ turn_text: "Done.", evidence: log.all(), fresh_refs: log.takeFresh() });
		const claim = res.claims[0];
		expect(claim).toMatchObject({ kind: "command_success", verdict: "contradicted" });

		const line = formatFlag(claim!);
		expect(line).toContain("FALSE CLAIM");
		expect(line).toContain("`exit 1` exited 1");
		expect(feedbackFor([claim!])).toContain("Done.");
	});

	it("records a diff for Write and Edit, and verifies a bug fix after a passing rerun", async () => {
		const file = join(dir, "sum.sh");
		const log = new EvidenceLog();
		const record = (tool: string) => (exec: RawExecution) => log.record(tool, exec);

		await writeTool.execute({ path: file, content: "exit 1\n" }, { onExecution: record("Write") });
		await bashTool.execute({ command: `sh ${file}` }, { onExecution: record("Bash") });
		await editTool.execute(
			{ path: file, old_string: "exit 1", new_string: "exit 0" },
			{ onExecution: record("Edit") },
		);
		await bashTool.execute({ command: `sh ${file}` }, { onExecution: record("Bash") });

		expect(await readFile(file, "utf-8")).toBe("exit 0\n");
		expect(log.all()[2]?.diff).toContain("+exit 0");

		const res = await client.check({ turn_text: "I fixed the bug.", evidence: log.all(), fresh_refs: [] });
		expect(res.claims[0]).toMatchObject({ kind: "bug_fixed", verdict: "verified" });
	});

	it("records a failed write so a creation claim is contradicted", async () => {
		const log = new EvidenceLog();
		await writeTool.execute(
			{ path: join(dir, "missing-dir-file", "\0bad"), content: "x" },
			{ onExecution: (exec) => log.record("Write", exec) },
		);
		expect(log.all()[0]?.is_error).toBe(true);
		const res = await client.check({ turn_text: "I created the file.", evidence: log.all(), fresh_refs: [] });
		expect(res.claims[0]).toMatchObject({ kind: "file_created", verdict: "contradicted" });
	});
});

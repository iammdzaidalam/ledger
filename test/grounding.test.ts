import { afterEach, describe, expect, it } from "vitest";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";

const bash = (command: string, exit_code: number | null, raw_stdout = "", raw_stderr = "") => ({
	args: { command },
	raw_stdout,
	raw_stderr,
	exit_code,
	executed: true,
	is_error: exit_code !== 0,
	duration_ms: 10,
});

describe("GroundingClient against the real checker binary", () => {
	let client: GroundingClient;

	afterEach(() => {
		client?.close();
	});

	it("contradicts a tests-pass claim when the runner failed", async () => {
		client = new GroundingClient();
		const log = new EvidenceLog();
		log.record("Bash", bash("npm test", 1, "", "Error: Cannot find module 'foo'"));
		const res = await client.check({
			turn_text: "Tests pass now, all good.",
			evidence: log.all(),
			fresh_refs: log.takeFresh(),
		});
		expect(res.claims).toHaveLength(1);
		expect(res.claims[0]).toMatchObject({ kind: "tests_pass", verdict: "contradicted", ref: "c1" });
	});

	it("flags a claim made with no evidence at all", async () => {
		client = new GroundingClient();
		const res = await client.check({
			turn_text: "I ran the tests and they all pass.",
			evidence: [],
			fresh_refs: [],
		});
		expect(res.claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
	});

	it("verifies a claim that matches the evidence", async () => {
		client = new GroundingClient();
		const log = new EvidenceLog();
		log.record("Bash", bash("go test ./...", 0, "ok  \tledger/checker\t0.002s\n"));
		const res = await client.check({
			turn_text: "Tests pass.",
			evidence: log.all(),
			fresh_refs: log.takeFresh(),
		});
		expect(res.claims[0]).toMatchObject({ verdict: "verified" });
	});

	it("only attributes a claim to the call it is about", async () => {
		client = new GroundingClient();
		const log = new EvidenceLog();
		log.record("Bash", bash("npm run lint", 1, "✖ 1 problem (1 error, 0 warnings)"));
		log.record("Bash", bash("npx vitest run", 0, "      Tests  3 passed (3)\n"));
		const res = await client.check({
			turn_text: "Lint still reports one error, but the tests pass.",
			evidence: log.all(),
			fresh_refs: log.takeFresh(),
		});
		expect(res.claims).toEqual([
			expect.objectContaining({ kind: "tests_pass", verdict: "verified", ref: "c2" }),
		]);
	});

	it("answers concurrent checks in order", async () => {
		client = new GroundingClient();
		const [a, b] = await Promise.all([
			client.check({ turn_text: "Tests pass.", evidence: [], fresh_refs: [] }),
			client.check({ turn_text: "Nothing to report here", evidence: [], fresh_refs: [] }),
		]);
		expect(a.claims).toHaveLength(1);
		expect(b.claims).toHaveLength(0);
	});
});

describe("EvidenceLog", () => {
	it("hands out sequential refs and drains fresh refs once", () => {
		const log = new EvidenceLog();
		expect(log.record("Bash", bash("ls", 0)).ref).toBe("c1");
		expect(log.record("Bash", bash("pwd", 0)).ref).toBe("c2");
		expect(log.takeFresh()).toEqual(["c1", "c2"]);
		expect(log.takeFresh()).toEqual([]);
	});
});

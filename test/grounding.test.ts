import { describe, expect, it } from "vitest";
import { GroundingClient } from "../src/grounding/client.js";

// Exercises the real subprocess protocol end to end. Requires
// `npm run checker:build` to have produced bin/grounding-checker first.
describe("GroundingClient against the real checker binary", () => {
	it("flags a success claim when the command actually failed", async () => {
		const client = new GroundingClient();
		const result = await client.check({
			tool: "Bash",
			args: { command: "npm test" },
			raw_stdout: "",
			raw_stderr: "ModuleNotFoundError: no module named foo",
			exit_code: 1,
			executed: true,
			duration_ms: 42,
			model_claimed: "Tests pass now, all good.",
		});
		expect(result.claim_check.matches_evidence).toBe(false);
	});

	it("hard-fails when the tool never actually ran", async () => {
		const client = new GroundingClient();
		const result = await client.check({
			tool: "Bash",
			args: { command: "some-command" },
			raw_stdout: "",
			raw_stderr: "",
			exit_code: null,
			executed: false,
			duration_ms: 0,
			model_claimed: "Done.",
		});
		expect(result.claim_check.matches_evidence).toBe(false);
	});

	it("passes through a claim that matches the evidence", async () => {
		const client = new GroundingClient();
		const result = await client.check({
			tool: "Bash",
			args: { command: "go test ./..." },
			raw_stdout: "ok  \tledger/checker\t0.002s\n",
			raw_stderr: "",
			exit_code: 0,
			executed: true,
			duration_ms: 15,
			model_claimed: "Tests pass.",
		});
		expect(result.claim_check.matches_evidence).toBe(true);
	});
});

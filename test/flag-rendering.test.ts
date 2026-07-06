import { describe, expect, it } from "vitest";
import { GroundingClient } from "../src/grounding/client.js";
import { formatFlag } from "../src/grounding/format.js";
import { bashTool } from "../src/tools/bash.js";
import type { RawExecution } from "../src/tools/types.js";

// Runs the real chain a live agent turn would trigger: bash tool captures
// evidence -> grounding checker evaluates a false claim -> formatFlag renders it.
describe("bash tool -> grounding checker -> terminal flag", () => {
	it("flags a model claiming success on a command that actually failed", async () => {
		let captured: RawExecution | undefined;
		await bashTool.execute({ command: "exit 1" }, { onExecution: (exec) => (captured = exec) });

		expect(captured).toBeDefined();
		expect(captured?.exit_code).toBe(1);
		expect(captured?.executed).toBe(true);

		const client = new GroundingClient();
		const verified = await client.check({
			tool: "Bash",
			...captured!,
			model_claimed: "All good, tests pass now.",
		});

		expect(verified.claim_check.matches_evidence).toBe(false);

		const line = formatFlag(verified);
		expect(line).toContain("UNVERIFIED CLAIM");
		expect(line).toContain("Bash exited 1");
	});
});

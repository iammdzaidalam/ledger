import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs } from "../src/cli/args.js";
import { parseSwarmArgs } from "../src/swarm/args.js";

describe("parseSwarmArgs", () => {
	it("applies the defaults", () => {
		expect(parseSwarmArgs(["fix", "the", "build"])).toEqual({
			goal: "fix the build",
			workers: 3,
			gate: true,
			subtasks: [],
			json: false,
		});
	});

	it("reads every flag", () => {
		const args = parseSwarmArgs([
			"goal",
			"--workers",
			"5",
			"--server",
			"http://h:1",
			"--no-gate",
			"--max-attempts",
			"2",
			"--plan",
			"4",
			"--base",
			"develop",
			"--json",
			"--provider",
			"ollama",
			"--model",
			"qwen2.5:7b",
		]);
		expect(args).toMatchObject({
			goal: "goal",
			workers: 5,
			server: "http://h:1",
			gate: false,
			maxAttempts: 2,
			plan: 4,
			base: "develop",
			json: true,
			provider: "ollama",
			model: "qwen2.5:7b",
		});
	});

	it("collects repeated --subtask values", () => {
		const args = parseSwarmArgs(["goal", "--subtask", "edit a", "--subtask", "edit b"]);
		expect(args.subtasks).toEqual(["edit a", "edit b"]);
	});

	it("allows --resume without a goal", () => {
		const args = parseSwarmArgs(["--resume", "abc"]);
		expect(args.resume).toBe("abc");
		expect(args.goal).toBeUndefined();
	});

	it("rejects bad input", () => {
		expect(() => parseSwarmArgs([])).toThrow("needs a goal");
		expect(() => parseSwarmArgs(["g", "--workers", "0"])).toThrow("--workers must be");
		expect(() => parseSwarmArgs(["g", "--workers", "two"])).toThrow("--workers must be");
		expect(() => parseSwarmArgs(["g", "--server"])).toThrow("--server needs a value");
		expect(() => parseSwarmArgs(["g", "--base", "--json"])).toThrow("--base needs a value");
		expect(() => parseSwarmArgs(["g", "--plan", "2", "--subtask", "x"])).toThrow("cannot be used together");
	});
});

describe("ordinary CLI args", () => {
	it("reads --server", () => {
		expect(parseArgs(["--server", "http://h:1", "hi"])).toMatchObject({
			server: "http://h:1",
			message: "hi",
		});
	});

	it("documents swarm in the help text", () => {
		expect(HELP_TEXT).toContain('ledger swarm "<goal>"');
		expect(HELP_TEXT).toContain("--workers");
	});
});

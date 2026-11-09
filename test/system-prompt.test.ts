import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/config/system-prompt.js";
import { CORE_TOOLS, getToolDefinitions } from "../src/tools/index.js";

const listed = (prompt: string) =>
	prompt
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).split(":")[0]);

describe("buildSystemPrompt", () => {
	it("keeps the eval prompt to the seven core tools with no mention of git or permissions", async () => {
		const prompt = await buildSystemPrompt(undefined, "prose", CORE_TOOLS);
		expect(listed(prompt)).toEqual([...CORE_TOOLS]);
		expect(prompt).toContain("(Read, Write, Edit, Bash, Grep, Find, Ls). Use them");
		expect(prompt).not.toMatch(/Git|deny/);
	});

	it("lists every registered tool and the denied-call rule by default", async () => {
		const prompt = await buildSystemPrompt();
		expect(listed(prompt)).toEqual(getToolDefinitions().map((t) => t.name));
		expect(prompt).toContain("a denied call did\nnot run");
	});
});

import { describe, expect, it } from "vitest";
import type { Provider } from "../src/providers/types.js";
import {
	firstJsonArray,
	parseSubtasks,
	planFromText,
	plannerMessage,
	plannerSystem,
	planSubtasks,
} from "../src/swarm/planner.js";
import { scriptedProvider } from "./helpers.js";

const two = '[{"title":"API","prompt":"Edit api.ts"},{"title":"UI","prompt":"Edit ui.ts"}]';

describe("parseSubtasks", () => {
	it("reads a clean array", () => {
		expect(parseSubtasks(two, 5)).toEqual([
			{ title: "API", prompt: "Edit api.ts" },
			{ title: "UI", prompt: "Edit ui.ts" },
		]);
	});

	it("finds the array inside prose and code fences", () => {
		const text = `Sure! Here is the plan:\n\`\`\`json\n${two}\n\`\`\`\nLet me know if you want changes.`;
		expect(parseSubtasks(text, 5)).toHaveLength(2);
	});

	it("skips an earlier bracket that is not the array", () => {
		const text = `Files [a.ts, b.ts] are involved.\n${two}`;
		expect(parseSubtasks(text, 5)).toHaveLength(2);
	});

	it("handles brackets and quotes inside strings", () => {
		const text = '[{"title":"x","prompt":"use arr[0] and \\"]\\" safely"},{"title":"y","prompt":"other"}]';
		expect(parseSubtasks(text, 5)[0]?.prompt).toBe('use arr[0] and "]" safely');
	});

	it("drops entries without a prompt and non-objects", () => {
		const text = '[{"title":"a"},"nope",null,{"title":"b","prompt":"  "},{"title":"c","prompt":"do c"}]';
		expect(parseSubtasks(text, 5)).toEqual([{ title: "c", prompt: "do c" }]);
	});

	it("derives a title from the prompt when missing", () => {
		expect(parseSubtasks('[{"prompt":"Rename the helper\\nthen update callers"}]', 5)).toEqual([
			{ title: "Rename the helper", prompt: "Rename the helper\nthen update callers" },
		]);
	});

	it("removes duplicates by title or prompt, case-insensitively", () => {
		const text =
			'[{"title":"API","prompt":"one"},{"title":"api","prompt":"two"},{"title":"Other","prompt":"ONE"},{"title":"New","prompt":"three"}]';
		expect(parseSubtasks(text, 5).map((s) => s.title)).toEqual(["API", "New"]);
	});

	it("caps the count", () => {
		const text = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` })));
		expect(parseSubtasks(text, 3)).toHaveLength(3);
	});

	it("returns nothing for garbage, truncated or empty output", () => {
		expect(parseSubtasks("I cannot help with that.", 3)).toEqual([]);
		expect(parseSubtasks('[{"title":"a","prompt":"b"', 3)).toEqual([]);
		expect(parseSubtasks("[]", 3)).toEqual([]);
		expect(parseSubtasks("[1,2,3]", 3)).toEqual([]);
		expect(parseSubtasks("", 3)).toEqual([]);
	});

	it("firstJsonArray ignores arrays of plain values", () => {
		expect(firstJsonArray('[1,2] then [{"a":1}]')).toEqual([{ a: 1 }]);
	});
});

describe("planFromText", () => {
	it("falls back to the whole goal when the output is garbage", () => {
		expect(planFromText("fix the build", "no idea", 3)).toEqual([
			{ title: "fix the build", prompt: "fix the build" },
		]);
	});

	it("uses the whole goal when the model returns a single piece", () => {
		const text = '[{"title":"all","prompt":"just part of it"}]';
		expect(planFromText("fix the build and docs", text, 3)[0]?.prompt).toBe("fix the build and docs");
	});
});

describe("planSubtasks", () => {
	it("asks for at most N independent subtasks and lists the files", async () => {
		const seen: Parameters<Provider["complete"]>[0][] = [];
		const base = scriptedProvider([{ text: two }]);
		const provider: Provider = {
			name: "spy",
			complete(options) {
				seen.push(options);
				return base.complete(options);
			},
		};
		const result = await planSubtasks({
			goal: "add flags",
			files: ["src/a.ts", "src/b.ts"],
			provider,
			model: "m",
			max: 2,
		});
		expect(result).toHaveLength(2);
		expect(seen[0]?.system).toContain("at most 2");
		expect(seen[0]?.system).toContain("touch different files");
		expect(seen[0]?.system).toContain("any order");
		expect(JSON.stringify(seen[0]?.messages)).toContain("src/b.ts");
	});

	it("falls back to one subtask when the provider throws", async () => {
		const provider: Provider = {
			name: "broken",
			// biome-ignore lint/correctness/useYield: simulates a provider that fails immediately
			async *complete() {
				throw new Error("connection refused");
			},
		};
		const result = await planSubtasks({ goal: "do it", files: [], provider, model: "m", max: 3 });
		expect(result).toEqual([{ title: "do it", prompt: "do it" }]);
	});

	it("does not call the model when only one subtask is allowed", async () => {
		const provider: Provider = {
			name: "never",
			complete() {
				throw new Error("should not be called");
			},
		};
		const result = await planSubtasks({ goal: "x", files: [], provider, model: "m", max: 1 });
		expect(result).toHaveLength(1);
	});

	it("caps the file list in the prompt", () => {
		const files = Array.from({ length: 1000 }, (_, i) => `f${i}.ts`);
		const message = plannerMessage("g", files);
		expect(message).toContain("f399.ts");
		expect(message).not.toContain("f400.ts");
		expect(message).toContain("600 more files");
		expect(plannerSystem(4)).toContain("at most 4");
	});
});

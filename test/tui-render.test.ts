import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import type { ClaimResult } from "../src/grounding/types.js";
import { type Editor, editKey, editorLines, moveVertical } from "../src/tui/editor.js";
import { assistantLines, panelLines } from "../src/tui/layout.js";
import { inline, markdownRows, renderMarkdown } from "../src/tui/markdown.js";
import { answerFor, choiceForKey, PermissionQueue } from "../src/tui/permission.js";
import type { AssistantEntry } from "../src/tui/state.js";
import { type Line, sanitize, wrap } from "../src/tui/text.js";
import { annotate, placeClaims } from "../src/tui/verdicts.js";

const text = (lines: Line[]) => lines.map((l) => l.map((s) => s.text).join("")).join("\n");

function claim(text: string, verdict: ClaimResult["verdict"], ref?: string, reason = "why"): ClaimResult {
	return { text, kind: "tests_pass", verdict, ref, attribution: "family", rule: "r", reason };
}

function key(overrides: Partial<Key> = {}): Key {
	return {
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		home: false,
		end: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		super: false,
		hyper: false,
		capsLock: false,
		numLock: false,
		...overrides,
	};
}

describe("markdown renderer", () => {
	it("styles bold, italic and inline code, and leaves snake_case alone", () => {
		const segs = inline("Run **npm test** in `src/app.ts`, not *later* or my_var_name.");
		expect(segs.find((s) => s.text === "npm test")?.style).toMatchObject({ bold: true });
		expect(segs.find((s) => s.text === "src/app.ts")?.style).toMatchObject({ tone: "accent" });
		expect(segs.find((s) => s.text === "later")?.style).toMatchObject({ italic: true });
		expect(segs.map((s) => s.text).join("")).toBe("Run npm test in src/app.ts, not later or my_var_name.");
	});

	it("keeps a lone asterisk as text", () => {
		expect(
			inline("2 * 3 = 6")
				.map((s) => s.text)
				.join(""),
		).toBe("2 * 3 = 6");
	});

	it("renders headings, lists, code fences and rules", () => {
		const md = [
			"# Plan",
			"",
			"- first item",
			"  - nested",
			"1. numbered",
			"```ts",
			"const a = 1;",
			"```",
			"---",
			"end",
		].join("\n");
		const rows = markdownRows(md);
		expect(rows[0]?.body[0]?.style).toMatchObject({ bold: true, underline: true });
		const out = text(renderMarkdown(md, 40));
		expect(out).toBe(
			[
				"Plan",
				"",
				"• first item",
				"  • nested",
				"1. numbered",
				"│ ts",
				"│ const a = 1;",
				"─".repeat(40),
				"end",
			].join("\n"),
		);
	});

	it("treats an unclosed fence as code while it streams", () => {
		const out = text(renderMarkdown("Here:\n```\nnpm test **not bold**", 40));
		expect(out).toBe("Here:\n│ npm test **not bold**");
	});

	it("wraps long list items with a hanging indent", () => {
		const out = text(renderMarkdown("- one two three four five six", 12));
		expect(out.split("\n")).toEqual(["• one two", "  three four", "  five six"]);
	});

	it("shows links as their label with the url dimmed", () => {
		const segs = inline("see [the docs](https://x.dev)");
		expect(segs.map((s) => s.text)).toEqual(["see ", "the docs", " (https://x.dev)"]);
	});
});

describe("text helpers", () => {
	it("strips escape codes and control characters", () => {
		expect(sanitize("\u001b[31mred\u001b[0m\r\nok\u0007\tx")).toBe("red\nok    x");
	});

	it("breaks words longer than the width", () => {
		expect(text(wrap([{ text: "abcdefghij" }], 4))).toBe("abcd\nefgh\nij");
	});
});

describe("verdict placement", () => {
	it("puts each mark after the sentence it came from", () => {
		const body = "I ran the tests. All tests pass. Lint is clean.";
		const { placed } = placeClaims(body, [{ text: "Lint is clean." }, { text: "All tests pass." }]);
		expect(placed.map((p) => [p.index, body.slice(p.start, p.end)])).toEqual([
			[0, "Lint is clean."],
			[1, "All tests pass."],
		]);
	});

	it("gives repeated sentences one mark each, in order", () => {
		const body = "Done. Then I checked again. Done.";
		const { placed } = placeClaims(body, [{ text: "Done." }, { text: "Done." }]);
		expect(placed.map((p) => p.start)).toEqual([0, body.lastIndexOf("Done.")]);
	});

	it("skips text inside code fences and matches across reflowed whitespace", () => {
		const body = "```\nAll tests pass.\n```\nAll tests\n  pass.";
		const { placed } = placeClaims(body, [{ text: "All tests pass." }]);
		expect(placed[0]?.start).toBe(body.indexOf("All tests\n"));
	});

	it("reports claims it cannot find", () => {
		expect(placeClaims("Nothing here.", [{ text: "Tests pass." }]).unplaced).toEqual([0]);
	});

	it("handles clauses that share a sentence", () => {
		const body = "Lint has one error, but the tests pass.";
		const marked = annotate(body, [{ text: "Lint has one error, but" }, { text: "the tests pass." }]).text;
		expect(marked.replace(/[](\d+)/g, (m, n) => (m.startsWith("") ? `<${n}>` : `</${n}>`))).toBe(
			"<0>Lint has one error, but</0> <1>the tests pass.</1>",
		);
	});

	it("renders the verdict inline after the offending sentence", () => {
		const entry: AssistantEntry = {
			kind: "assistant",
			key: 1,
			run: 1,
			text: "I ran the tests. All tests pass. Lint is clean.",
			streaming: false,
			turn: 2,
			claims: [
				claim("All tests pass.", "contradicted", "c1", "c1 exited 1 with 2 failed tests"),
				claim("Lint is clean.", "verified", "c2"),
			],
			outcomes: {},
		};
		const lines = assistantLines(entry, 200);
		const out = text(lines);
		expect(out).toContain(
			"All tests pass. [✗ CONTRADICTED c1: c1 exited 1 with 2 failed tests] Lint is clean. ✓ c2",
		);
		const flagged = lines.flat().find((s) => s.text.includes("All tests pass."));
		expect(flagged?.style).toMatchObject({ underline: true });
		const tag = lines.flat().find((s) => s.text === "✗ CONTRADICTED");
		expect(tag?.style).toMatchObject({ tone: "bad", bold: true });
		const check = lines.flat().find((s) => s.text.startsWith("✓"));
		expect(check?.style).toMatchObject({ dim: true });
	});

	it("lists claims it could not place under the message, and hides claim tags", () => {
		const entry: AssistantEntry = {
			kind: "assistant",
			key: 1,
			run: 1,
			text: 'Status: <claim ref="c3">build succeeded</claim>.',
			streaming: false,
			turn: 1,
			claims: [claim("build succeeded", "unverifiable", "c3"), claim("Something else.", "unsupported")],
			outcomes: { 1: "still_false" },
		};
		const out = text(assistantLines(entry, 200));
		expect(out).not.toContain("<claim");
		expect(out).toContain("build succeeded [? UNVERIFIABLE c3: why]");
		expect(out).toContain('↳ "Something else." [✗ UNSUPPORTED: why → still false after revision]');
	});
});

describe("panel", () => {
	it("shows the newest evidence and claims within its height", () => {
		const evidence = Array.from({ length: 8 }, (_, i) => ({
			ref: `c${i + 1}`,
			seq: i + 1,
			tool: "Bash",
			args: { command: `step ${i + 1}` },
			raw_stdout: "",
			raw_stderr: "",
			exit_code: i === 7 ? 1 : 0,
			executed: true,
			is_error: i === 7,
			duration_ms: 10,
		}));
		const claims = [{ key: 1, run: 1, turn: 2, claim: claim("All tests pass.", "contradicted", "c8") }];
		const out = text(panelLines({ evidence, claims }, 40, 8));
		expect(out.split("\n")).toHaveLength(8);
		expect(out).toContain("Evidence 8");
		expect(out).toContain("earlier");
		expect(out).toMatch(/c8\s+Bash\s+step 8\s+exit 1/);
		expect(out).toContain("✗ t2 c8   All tests pass.");
	});
});

describe("input editor", () => {
	const at = (text: string, cursor = text.length): Editor => ({ text, cursor });

	it("submits on Enter and adds a line on Ctrl+J, Alt+Enter or a trailing backslash", () => {
		expect(editKey(at("hi"), "\r", key({ return: true }))).toBe("submit");
		expect(editKey(at("hi"), "\n", key())).toEqual(at("hi\n"));
		expect(editKey(at("hi"), "\r", key({ return: true, meta: true }))).toEqual(at("hi\n"));
		expect(editKey(at("hi\\"), "\r", key({ return: true }))).toEqual(at("hi\n"));
	});

	it("edits in the middle of the text", () => {
		expect(editKey(at("hllo", 1), "e", key())).toEqual(at("hello", 2));
		expect(editKey(at("hello", 2), "", key({ backspace: true }))).toEqual(at("hllo", 1));
		expect(editKey(at("one two", 7), "w", key({ ctrl: true }))).toEqual(at("one ", 4));
		expect(editKey(at("a\nbc", 4), "u", key({ ctrl: true }))).toEqual(at("a\n", 2));
	});

	it("moves between lines and reports when it runs out", () => {
		expect(moveVertical(at("ab\ncd", 4), -1)).toEqual(at("ab\ncd", 1));
		expect(moveVertical(at("ab\ncd", 1), -1)).toBeNull();
		expect(moveVertical(at("ab\ncd", 1), 1)).toEqual(at("ab\ncd", 4));
	});

	it("draws the cursor on the right line", () => {
		const { lines, cursorLine } = editorLines(at("ab\ncd", 4), 20, true);
		expect(cursorLine).toBe(1);
		expect(lines[1]?.find((s) => s.style?.inverse)?.text).toBe("d");
	});
});

describe("permission queue", () => {
	const request = { tool: "Bash", input: { command: "npm test" }, summary: "npm test" };

	it("holds requests until answered, one at a time", async () => {
		const queue = new PermissionQueue();
		let changes = 0;
		queue.subscribe(() => changes++);
		const first = queue.ask(request, ["Bash(npm test)"]);
		const second = queue.ask({ ...request, summary: "rm -rf build" }, []);
		expect(queue.current()?.request.summary).toBe("npm test");
		queue.answer(answerFor("session", queue.current()?.rules ?? []));
		await expect(first).resolves.toEqual({ kind: "session" });
		expect(queue.current()?.request.summary).toBe("rm -rf build");
		queue.denyAll("cancelled");
		await expect(second).resolves.toEqual({ kind: "deny", reason: "cancelled" });
		expect(queue.current()).toBeUndefined();
		expect(changes).toBe(4);
	});

	it("maps keys to choices and falls back to once when nothing can be remembered", () => {
		expect(choiceForKey("y")).toBe("once");
		expect(choiceForKey("A")).toBe("session");
		expect(choiceForKey("n")).toBe("deny");
		expect(choiceForKey("x")).toBeNull();
		expect(answerFor("session", [])).toEqual({ kind: "once" });
	});
});

describe("wrapping across styles", () => {
	it("keeps a word together when it spans two styles", () => {
		const out = text(
			wrap([{ text: "see " }, { text: "src/app.ts", style: { tone: "accent" } }, { text: ": ok" }], 15),
		);
		expect(out).toBe("see src/app.ts:\nok");
	});
});

import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { shouldUseTui } from "../src/main.js";

describe("parseArgs", () => {
	it("reads the session flags", () => {
		expect(parseArgs(["--resume", "2026-11", "fix", "it"])).toMatchObject({
			resume: "2026-11",
			message: "fix it",
		});
		expect(parseArgs(["-c", "-y", "-p", "go"])).toMatchObject({
			continue: true,
			yes: true,
			print: true,
			message: "go",
		});
		expect(parseArgs(["--list-sessions"]).listSessions).toBe(true);
	});

	it("treats a lone `sessions` as the list command, but not a longer message", () => {
		const listing = parseArgs(["sessions"]);
		expect(listing.listSessions).toBe(true);
		expect(listing.message).toBeUndefined();
		expect(parseArgs(["sessions", "are", "broken"])).toMatchObject({
			listSessions: false,
			message: "sessions are broken",
		});
	});

	it("rejects a value flag with no value", () => {
		expect(() => parseArgs(["--resume"])).toThrow("--resume needs a value");
		expect(() => parseArgs(["--model", "--yes"])).toThrow("--model needs a value");
	});

	it("reads --no-tui", () => {
		expect(parseArgs(["--no-tui", "hi"])).toMatchObject({ noTui: true, message: "hi" });
		expect(parseArgs([]).noTui).toBe(false);
	});
});

describe("shouldUseTui", () => {
	it("uses the full-screen UI only on a terminal, unless turned off", () => {
		expect(shouldUseTui({ noTui: false }, {}, true, true)).toBe(true);
		expect(shouldUseTui({ noTui: true }, {}, true, true)).toBe(false);
		expect(shouldUseTui({ noTui: false }, { tui: false }, true, true)).toBe(false);
		expect(shouldUseTui({ noTui: false }, {}, true, false)).toBe(false);
		expect(shouldUseTui({ noTui: false }, {}, false, true)).toBe(false);
	});
});

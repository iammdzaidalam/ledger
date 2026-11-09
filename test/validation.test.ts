import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { formatLedger, revisionFeedback } from "../src/grounding/format.js";
import type { CheckResponse, ClaimResult } from "../src/grounding/types.js";
import { matchClaim, Validator, validationPolicy } from "../src/grounding/validation.js";
import { runPrint, UNVERIFIED_EXIT_CODE } from "../src/modes/print.js";
import type { CompletionOptions, Provider, StreamEvent } from "../src/providers/types.js";
import { ActiveSession } from "../src/session/active.js";

const claim = (over: Partial<ClaimResult>): ClaimResult => ({
	text: "All tests pass.",
	kind: "tests_pass",
	ref: "c1",
	attribution: "family",
	verdict: "contradicted",
	rule: "tests_pass",
	reason: "`npm test` exited 1 (vitest: 5 passed, 2 failed)",
	...over,
});

const checked = (...claims: ClaimResult[]): CheckResponse => ({ request_id: "0", claims });

describe("validationPolicy", () => {
	it("defaults to flag, maps the old feedback flag to revise, and caps the run at three times the budget", () => {
		expect(validationPolicy()).toEqual({ mode: "flag", maxRevisions: 1, maxRevisionsPerRun: 3 });
		expect(validationPolicy({ feedback: true }).mode).toBe("revise");
		expect(validationPolicy({ validate: "strict", feedback: true }).mode).toBe("strict");
		expect(validationPolicy({ validate: "revise", maxRevisions: 2 }).maxRevisionsPerRun).toBe(6);
		expect(validationPolicy({ maxRevisions: 2, maxRevisionsPerRun: 1 }).maxRevisionsPerRun).toBe(1);
	});
});

describe("Validator", () => {
	it("never sends verified or unverifiable claims back", () => {
		const v = new Validator(validationPolicy({ validate: "revise" }));
		const review = v.review(
			1,
			checked(
				claim({
					text: "Lint is clean.",
					kind: "lint_clean",
					verdict: "verified",
					reason: "`eslint .` exited 0",
				}),
				claim({ text: "The build works.", kind: "command_success", verdict: "unverifiable" }),
				claim({}),
			),
			0,
		);
		expect(review.request?.claims.map((c) => c.text)).toEqual(["All tests pass."]);
		expect(review.feedback).not.toContain("Lint is clean");
		expect(review.feedback).not.toContain("The build works");
	});

	it("does not open a revision for a turn whose only flags are unverifiable", () => {
		const v = new Validator(validationPolicy({ validate: "strict" }));
		expect(v.review(1, checked(claim({ verdict: "unverifiable" })), 0).feedback).toBeNull();
		expect(v.ledger()).toMatchObject({ unverified: false, entries: [{ status: "unverifiable" }] });
	});

	it("waits through tool-only turns before judging the revision", () => {
		const v = new Validator(validationPolicy({ validate: "revise" }));
		v.review(1, checked(claim({})), 0);
		expect(v.review(2, null, 1)).toEqual({ feedback: null });
		expect(v.review(3, checked(), 1)).toEqual({ feedback: null });
		const done = v.review(4, checked(claim({ ref: "c2", verdict: "verified", reason: "ok" })), 0);
		expect(done.result).toMatchObject({
			next: "accepted",
			outcomes: [{ outcome: "corrected", how: "verified" }],
		});
	});

	it("treats an empty revised answer as still false, and a checker error as unverified", () => {
		const v = new Validator(validationPolicy({ validate: "revise" }));
		v.review(1, checked(claim({})), 0);
		expect(v.review(2, null, 0).result).toMatchObject({
			next: "exhausted",
			outcomes: [{ outcome: "still_false" }],
		});

		const broken = new Validator(validationPolicy({ validate: "strict" }));
		broken.review(1, { request_id: "0", claims: [], error: "checker subprocess exited" }, 0);
		expect(broken.ledger()).toMatchObject({ checkerErrors: 1, falseClaims: 0, unverified: true });
	});

	it("closes an open revision as still false when the run ends first", () => {
		const v = new Validator(validationPolicy({ validate: "revise" }));
		v.review(1, checked(claim({})), 1);
		expect(v.finish().result).toMatchObject({ next: "ended", outcomes: [{ outcome: "still_false" }] });
	});
});

describe("matchClaim", () => {
	it("matches a file claim only on the same file", () => {
		const prev = claim({ kind: "file_created", text: "I created config.json.", ref: undefined });
		const other = claim({ kind: "file_created", text: "I created notes.txt.", ref: "c4" });
		const same = claim({ kind: "file_created", text: "Wrote `config.json` again.", ref: "c5" });
		expect(matchClaim(prev, [other], new Set())).toBe(-1);
		expect(matchClaim(prev, [other, same], new Set())).toBe(1);
	});

	it("matches a repo-state claim on kind alone", () => {
		expect(matchClaim(claim({}), [claim({ text: "Tests are green now.", ref: "c3" })], new Set())).toBe(0);
	});
});

describe("feedback and ledger text", () => {
	it("quotes the sentence, verdict, ref, fact and a fix", () => {
		const text = revisionFeedback([
			claim({}),
			claim({
				text: "I ran lint.",
				kind: "lint_clean",
				ref: undefined,
				verdict: "unsupported",
				reason: "no linter was run",
			}),
		]);
		expect(text).toContain(
			'- "All tests pass." (contradicted by c1): `npm test` exited 1 (vitest: 5 passed, 2 failed).',
		);
		expect(text).toContain("Fix the failures and rerun the tests");
		expect(text).toContain('- "I ran lint." (unsupported, no evidence): no linter was run. Run the linter');
	});

	it("renders one row per claim and dims unverifiable ones", () => {
		const v = new Validator(validationPolicy({ validate: "revise" }));
		v.review(
			1,
			checked(
				claim({}),
				claim({
					text: "Build is fine.",
					kind: "command_success",
					verdict: "unverifiable",
					reason: "no output",
				}),
			),
			0,
		);
		v.review(2, checked(), 0);
		const plain = formatLedger(v.ledger());
		expect(plain.split("\n")).toHaveLength(3);
		expect(plain).toContain(
			"ledger: 2 claims, 0 verified, 1 corrected, 0 false, 1 unverifiable, 1 revision(s)",
		);
		expect(plain).toMatch(/corrected\s+t1 c1\s+tests_pass\s+"All tests pass\."\s+retracted/);
		expect(formatLedger(v.ledger(), true)).toContain("\x1b[2m  unverifiable t1 c1");
		expect(formatLedger(new Validator(validationPolicy()).ledger())).toBe("");
	});
});

function liar(texts: string[]): Provider {
	let i = 0;
	return {
		name: "liar",
		async *complete(_options: CompletionOptions): AsyncGenerator<StreamEvent> {
			const step = i++;
			if (step === 0) {
				yield { type: "tool_use_start", id: "call_0", name: "Bash" };
				yield { type: "tool_use_input_delta", id: "call_0", delta: JSON.stringify({ command: "exit 1" }) };
				yield { type: "tool_use_end", id: "call_0" };
			} else {
				yield { type: "text_delta", delta: texts[step - 1] ?? "" };
			}
			const stop_reason = step === 0 ? "tool_use" : "end_turn";
			yield { type: "message_end", stop_reason, usage: { input_tokens: 0, output_tokens: 0 } };
		},
	};
}

describe("print mode exit code", () => {
	let out: string[];
	let err: string[];
	let spies: MockInstance[];

	beforeEach(() => {
		out = [];
		err = [];
		spies = [
			vi.spyOn(process.stdout, "write").mockImplementation((chunk) => out.push(String(chunk)) > 0),
			vi.spyOn(process.stderr, "write").mockImplementation((chunk) => err.push(String(chunk)) > 0),
		];
	});

	afterEach(() => {
		for (const spy of spies) spy.mockRestore();
	});

	const run = (validate: "flag" | "revise" | "strict", texts: string[]) =>
		runPrint({
			session: ActiveSession.create(
				"print-exit",
				"liar",
				"liar",
				mkdtempSync(join(tmpdir(), "ledger-print-")),
			),
			turn: { system: "", validate, autoCompact: false, provider: liar(texts) },
			yes: true,
			message: "go",
			canPrompt: false,
		});

	it("exits non-zero in strict mode when a claim is still false", async () => {
		const code = await run("strict", ["Done, it worked.", "Done, it worked."]);
		expect(code).toBe(UNVERIFIED_EXIT_CODE);
		expect(out.join("")).toContain(
			"[UNVERIFIED] This answer contains unverified claims: 1 claim did not hold up.",
		);
		expect(err.join("")).toContain("ledger: 1 claim, 0 verified, 0 corrected, 1 false");
	});

	it("exits zero in strict mode once the model corrects itself", async () => {
		const code = await run("strict", ["Done, it worked.", "Sorry, the command exited 1."]);
		expect(code).toBe(0);
		expect(out.join("")).not.toContain("UNVERIFIED");
	});

	it("keeps exit zero and stdout clean outside strict mode", async () => {
		expect(await run("revise", ["Done, it worked.", "Done, it worked."])).toBe(0);
		expect(out.join("")).not.toContain("ledger:");
		expect(err.join("")).toContain("1 false");
	});
});

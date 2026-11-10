import type { CheckResponse, EvidenceEntry } from "../lib/checker";
import { decide, feedback } from "../lib/gate";
import { latency } from "../components/Annotated";
import type { AppStep, Tone } from "./types";

export interface CheckerInput {
	message: string;
	prompt: string;
	evidence: EvidenceEntry[];
	result: CheckResponse;
	browserTimed: boolean;
	gate: boolean;
	attempt: number;
	max: number;
}

const RULE_SOURCE: Record<string, string> = {
	tests_pass: "tests_pass",
	lint_clean: "lint_clean",
	file_created: "file_created",
	bug_fixed: "bug_fixed",
	command_success: "command_success",
	not_executed: "not_executed",
};

const WORST: Record<string, Tone> = { contradicted: "bad", unsupported: "warn", unverifiable: "warn", verified: "ok" };

function brief(e: EvidenceEntry) {
	const output = (e.raw_stderr || e.raw_stdout).trim();
	const target = e.tool === "Bash" ? e.args.command : (e.args.path ?? e.args.pattern);
	return {
		ref: e.ref,
		tool: e.tool,
		target,
		exit_code: e.exit_code,
		is_error: e.is_error,
		output: output.length > 100 ? `${output.slice(0, 100)}...` : output,
	};
}

export function checkerSteps(input: CheckerInput): AppStep[] {
	const { result, evidence, message, gate, attempt, max } = input;
	const claims = result.claims;
	const flagged = result.flagged;
	const changed = result.changed_files;
	const kinds = [...new Set(claims.map((c) => c.rule))];
	const worst = claims.find((c) => c.verdict === "contradicted") ?? claims.find((c) => c.verdict === "unsupported") ?? claims[0];
	const verdictText = claims.length === 0 ? "no claims" : worst.verdict;
	const gateInput = {
		gate,
		exitCode: 0,
		error: "",
		branch: changed ? "ledger/swarm-1" : "",
		commit: changed ? "a1b2c3d" : "",
		lastFlagged: flagged,
		attempt,
		maxAttempts: max,
	};
	const decision = decide(gateInput);
	const fb = feedback(claims);
	const gateTone: Tone = decision.decision === "pass" ? "ok" : decision.decision === "retry" ? "warn" : "bad";
	const emptyNote = claims.length === 0 ? " This reply holds no claim, so there is nothing to judge." : "";
	const gateNote = gate ? "" : " The gate is off, so the verdict is recorded and the decision ignores it.";

	const steps: AppStep[] = [
		{
			phase: "Record",
			title: "Tool calls are recorded",
			desc: `Every Bash, Write and Edit call is written to the evidence log with its exit code and output before the agent answers. ${evidence.length} ${evidence.length === 1 ? "call" : "calls"} here.`,
			src: "evidence",
			nodes: ["evidence"],
			edges: [],
			payload: evidence.map(brief),
			messages: [{ label: "Task", text: input.prompt }],
			events: [],
			badges: { evidence: { text: `${evidence.length} ${evidence.length === 1 ? "call" : "calls"}`, tone: "info" } },
		},
		{
			phase: "Reply",
			title: "The agent ends its turn",
			desc: "The final message is the text the checker will judge.",
			src: null,
			nodes: ["msg"],
			edges: [],
			payload: { turn_text: message },
			messages: [{ label: "Agent said", text: message || "(empty)" }],
			events: [{ type: "attempt.turn", text: "turn recorded by the worker" }],
			badges: { msg: { text: `${message.length} chars`, tone: "info" } },
		},
		{
			phase: "Split",
			title: "The reply becomes claims",
			desc: `Plans, hedges and questions are skipped. A sentence that says something happened becomes a claim.${emptyNote}`,
			src: "split",
			nodes: ["msg", "split"],
			edges: ["msg-split"],
			payload: { sentences_with_claims: claims.map((c) => c.text) },
			messages: [],
			events: [],
			badges: {},
		},
		{
			phase: "Claims",
			title: `${claims.length} ${claims.length === 1 ? "claim" : "claims"} found`,
			desc: "Each claim gets a kind: tests_pass, lint_clean, file_created, bug_fixed or command_success.",
			src: "split",
			nodes: ["split", "claim"],
			edges: ["split-claim"],
			payload: claims.map((c) => ({ kind: c.kind, text: c.text })),
			messages: claims.map((c) => ({ label: c.kind, text: c.text })),
			events: [],
			badges: { claim: { text: `${claims.length} found`, tone: claims.length ? "info" : "warn" } },
		},
		{
			phase: "Match",
			title: "Each claim finds its evidence",
			desc: "A claim tag wins, then a command or path the sentence names, then the latest run of that kind.",
			src: "attribute",
			nodes: ["claim", "evidence", "attr"],
			edges: ["claim-attr", "evidence-attr"],
			payload: claims.map((c) => ({ kind: c.kind, ref: c.ref ?? null, attribution: c.attribution })),
			messages: [],
			events: [],
			badges: { attr: { text: claims.length ? claims.map((c) => c.ref ?? "none").join(", ") : "nothing", tone: "info" } },
		},
		{
			phase: "Rule",
			title: kinds.length === 0 ? "No rule runs" : `Rule: ${kinds.join(", ")}`,
			desc: "The rule for the claim's kind reads the matched call: exit code, test summary, diff.",
			src: claims.length ? (RULE_SOURCE[claims[0].rule] ?? "evaluate") : "evaluate",
			nodes: ["attr", "rule"],
			edges: ["attr-rule"],
			payload: claims.map((c) => ({ kind: c.kind, rule: c.rule })),
			messages: [],
			events: [],
			badges: { rule: { text: kinds.length ? kinds.join(", ") : "none", tone: "info" } },
		},
		{
			phase: "Verdict",
			title: claims.length === 0 ? "Nothing to judge" : `Verdict: ${verdictText}`,
			desc: "Verified means the record backs the sentence. Contradicted means it says the opposite. Unsupported means no call covers it.",
			src: "evaluate",
			nodes: ["rule", "verdict"],
			edges: ["rule-verdict"],
			payload: claims.map((c) => ({ text: c.text, verdict: c.verdict, reason: c.reason })),
			messages: claims.map((c) => ({ label: c.verdict, text: c.reason })),
			events: [],
			badges: { verdict: { text: verdictText, tone: claims.length ? WORST[worst.verdict] : "info" } },
		},
		{
			phase: "Response",
			title: `Checked in ${latency(result.latency_us)}`,
			desc: `The wasm build of the same Go checker answered in ${latency(result.latency_us)}${input.browserTimed ? ", timed in this tab" : ", timed when the site was built"}. No model call is involved.`,
			src: "evaluate",
			nodes: ["verdict"],
			edges: [],
			payload: { flagged, changed_files: changed, latency_us: result.latency_us, claims },
			messages: [],
			events: [{ type: "verdict.recorded", text: flagged ? "flagged" : "clean" }],
			badges: { verdict: { text: `${verdictText} · ${latency(result.latency_us)}`, tone: claims.length ? WORST[worst.verdict] : "info" } },
		},
		{
			phase: "Gate",
			title: "The gate reads the verdict",
			desc: `The decision uses whether the last turn was flagged, whether any file changed, and the attempt number.${gateNote}`,
			src: "decide",
			nodes: ["verdict", "gate"],
			edges: ["verdict-gate"],
			payload: gateInput,
			messages: [],
			events: [],
			badges: {},
		},
		{
			phase: "Gate",
			title: `Decision: ${decision.decision.toUpperCase()}`,
			desc: `${decision.reason}.`,
			src: "decide",
			nodes: ["gate"],
			edges: [],
			payload: decision,
			messages: [{ label: "Reason", text: decision.reason }],
			events: [{ type: `gate.${decision.decision}`, text: decision.reason }],
			badges: { gate: { text: decision.decision.toUpperCase(), tone: gateTone } },
		},
	];

	if (decision.decision === "retry") {
		steps.push(
			{
				phase: "Outcome",
				title: "Feedback is written",
				desc: "A retry carries the flagged claims, or a note to change files when none were flagged.",
				src: "feedback",
				nodes: ["gate", "feedback"],
				edges: ["gate-feedback"],
				payload: { feedback: fb },
				messages: [{ label: "Feedback", text: fb }],
				events: [{ type: "task.queued", text: "retry with feedback" }],
				badges: { feedback: { text: "stored on the task", tone: "warn" } },
			},
			{
				phase: "Outcome",
				title: `Attempt ${attempt + 1} of ${max} runs`,
				desc: "The worker starts again from the earlier commit with the feedback in front of its prompt.",
				src: "withFeedback",
				nodes: ["feedback", "next"],
				edges: ["feedback-next"],
				payload: { attempt: attempt + 1, maxAttempts: max, prompt_prefix: fb.split("\n")[0] },
				messages: [{ label: "In its prompt", text: fb }],
				events: [{ type: "task.claimed", text: `attempt ${attempt + 1} claimed` }],
				badges: { next: { text: `attempt ${attempt + 1}`, tone: "warn" } },
			},
		);
	} else if (decision.decision === "pass") {
		steps.push(
			{
				phase: "Outcome",
				title: "The attempt is passed",
				desc: "A passed attempt goes to the merge queue.",
				src: "decide",
				nodes: ["gate", "merge"],
				edges: ["gate-merge"],
				payload: { decision: "pass", branch: gateInput.branch || null, commit: gateInput.commit || null },
				messages: [],
				events: [{ type: "task.merging", text: "merging" }],
				badges: { merge: { text: "queued", tone: "ok" } },
			},
			{
				phase: "Outcome",
				title: "Merged into the integration branch",
				desc: "Merges run one at a time on the integration branch.",
				src: "decide",
				nodes: ["merge"],
				edges: [],
				payload: { state: "merged" },
				messages: [],
				events: [{ type: "task.merged", text: "merged" }],
				badges: { merge: { text: "merged", tone: "ok" } },
			},
		);
	} else {
		steps.push(
			{
				phase: "Outcome",
				title: "Nothing merges",
				desc: `${decision.decision === "block" ? "Still flagged on the last attempt." : "The task fails."} ${decision.reason}.`,
				src: "decide",
				nodes: ["gate", "stop"],
				edges: ["gate-stop"],
				payload: decision,
				messages: [{ label: "Reason", text: decision.reason }],
				events: [{ type: `gate.${decision.decision}`, text: decision.reason }],
				badges: { stop: { text: decision.decision, tone: "bad" } },
			},
			{
				phase: "Outcome",
				title: "The task ends here",
				desc: "No commit reaches the integration branch from this task.",
				src: null,
				nodes: ["stop"],
				edges: [],
				payload: { merged: false },
				messages: [],
				events: [],
				badges: { stop: { text: "ended", tone: "bad" } },
			},
		);
	}
	return steps;
}

import { revisionFeedback } from "./format.js";
import type { CheckResponse, ClaimKind, ClaimResult, Verdict } from "./types.js";

export const VALIDATION_MODES = ["off", "flag", "revise", "strict"] as const;
export type ValidationMode = (typeof VALIDATION_MODES)[number];

export const DEFAULT_MAX_REVISIONS = 1;
const RUN_CAP_FACTOR = 3;

export interface ValidationPolicy {
	mode: ValidationMode;
	maxRevisions: number;
	maxRevisionsPerRun: number;
}

export interface ValidationSettings {
	validate?: ValidationMode;
	feedback?: boolean;
	maxRevisions?: number;
	maxRevisionsPerRun?: number;
}

export function isValidationMode(value: unknown): value is ValidationMode {
	return typeof value === "string" && (VALIDATION_MODES as readonly string[]).includes(value);
}

export function validationPolicy(settings: ValidationSettings = {}): ValidationPolicy {
	const mode = settings.validate ?? (settings.feedback ? "revise" : "flag");
	const maxRevisions = Math.max(0, settings.maxRevisions ?? DEFAULT_MAX_REVISIONS);
	const maxRevisionsPerRun = Math.max(0, settings.maxRevisionsPerRun ?? maxRevisions * RUN_CAP_FACTOR);
	return { mode, maxRevisions, maxRevisionsPerRun };
}

export function isFalseClaim(claim: ClaimResult): boolean {
	return claim.verdict === "contradicted" || claim.verdict === "unsupported";
}

export type ClaimStatus = "verified" | "corrected" | "false" | "unverifiable";
export type Correction = "retracted" | "verified" | "unverifiable";

export interface LedgerEntry {
	turn: number;
	text: string;
	kind: ClaimKind;
	ref?: string;
	firstVerdict: Verdict;
	verdict: Verdict;
	reason: string;
	status: ClaimStatus;
	correctedBy?: Correction;
	revisedText?: string;
	revisions: number;
	newInRevision: boolean;
}

export interface RunLedger {
	mode: ValidationMode;
	entries: LedgerEntry[];
	revisionsRequested: number;
	falseClaims: number;
	checkerErrors: number;
	unverified: boolean;
}

export type RevisionOutcome = "corrected" | "still_false" | "new_false";
export type RevisionNext = "accepted" | "revise" | "exhausted" | "capped" | "ended";

export interface ClaimOutcome {
	outcome: RevisionOutcome;
	claim: ClaimResult;
	revised?: ClaimResult;
	how?: Correction;
}

export interface RevisionRequest {
	turn: number;
	originTurn: number;
	round: number;
	maxRevisions: number;
	claims: ClaimResult[];
	feedback: string;
}

export interface RevisionResult {
	turn: number;
	originTurn: number;
	round: number;
	outcomes: ClaimOutcome[];
	next: RevisionNext;
}

export interface TurnReview {
	result?: RevisionResult;
	request?: RevisionRequest;
	feedback: string | null;
}

interface Pending {
	entry: LedgerEntry;
	claim: ClaimResult;
}

interface Chain {
	originTurn: number;
	round: number;
	pending: Pending[];
	fresh: string[];
}

const PATH_TOKEN = /[\w-]+(?:\/[\w.-]+)*\.[A-Za-z][\w]{0,7}\b/g;

function pathsIn(text: string): Set<string> {
	return new Set(text.match(PATH_TOKEN) ?? []);
}

function sharesPath(a: string, b: string): boolean {
	const left = pathsIn(a);
	for (const p of pathsIn(b)) if (left.has(p)) return true;
	return false;
}

export function matchClaim(previous: ClaimResult, claims: ClaimResult[], taken: Set<number>): number {
	const open = claims.flatMap((c, i) => (!taken.has(i) && c.kind === previous.kind ? [i] : []));
	const pick = (test: (c: ClaimResult) => boolean) => open.find((i) => test(claims[i] as ClaimResult));
	return (
		pick((c) => c.text === previous.text) ??
		pick((c) => previous.ref !== undefined && c.ref === previous.ref) ??
		pick((c) => sharesPath(c.text, previous.text)) ??
		(previous.kind === "file_created" ? undefined : open[0]) ??
		-1
	);
}

function statusOf(verdict: Verdict): ClaimStatus {
	if (verdict === "verified") return "verified";
	if (verdict === "unverifiable") return "unverifiable";
	return "false";
}

export class Validator {
	private entries: LedgerEntry[] = [];
	private chain: Chain | null = null;
	private used = 0;
	private checkerErrors = 0;
	private lastFresh: string[] = [];

	constructor(readonly policy: ValidationPolicy) {}

	get checks(): boolean {
		return this.policy.mode !== "off";
	}

	get revises(): boolean {
		return this.policy.mode === "revise" || this.policy.mode === "strict";
	}

	freshRefs(taken: string[]): string[] {
		const refs = this.chain ? [...new Set([...this.chain.fresh, ...taken])] : taken;
		if (this.chain) this.chain.fresh = refs;
		this.lastFresh = refs;
		return refs;
	}

	review(turn: number, check: CheckResponse | null, toolCalls: number): TurnReview {
		if (check?.error) this.checkerErrors++;
		if (this.chain) return this.continueChain(turn, check, toolCalls);
		if (!check || check.error) return { feedback: null };

		const bad = check.claims
			.map((claim) => ({ entry: this.add(turn, claim, false), claim }))
			.filter((p) => isFalseClaim(p.claim));
		if (bad.length === 0 || !this.revises || this.policy.maxRevisions === 0) return { feedback: null };
		if (this.used >= this.policy.maxRevisionsPerRun) return { feedback: null };

		this.chain = { originTurn: turn, round: 0, pending: bad, fresh: this.lastFresh };
		const request = this.request(turn, this.chain);
		return { request, feedback: request.feedback };
	}

	finish(): { result?: RevisionResult; ledger: RunLedger } {
		let result: RevisionResult | undefined;
		if (this.chain) {
			const chain = this.chain;
			result = {
				turn: chain.originTurn,
				originTurn: chain.originTurn,
				round: chain.round,
				outcomes: chain.pending.map((p) => ({ outcome: "still_false", claim: p.claim })),
				next: "ended",
			};
			this.chain = null;
		}
		return { result, ledger: this.ledger() };
	}

	ledger(): RunLedger {
		const falseClaims = this.entries.filter((e) => e.status === "false").length;
		return {
			mode: this.policy.mode,
			entries: this.entries.map((e) => ({ ...e })),
			revisionsRequested: this.used,
			falseClaims,
			checkerErrors: this.checkerErrors,
			unverified: falseClaims > 0 || this.checkerErrors > 0,
		};
	}

	private continueChain(turn: number, check: CheckResponse | null, toolCalls: number): TurnReview {
		const chain = this.chain as Chain;
		const claims = check && !check.error ? check.claims : null;
		if (toolCalls > 0 && (claims === null || claims.length === 0)) return { feedback: null };

		if (check?.error) {
			this.chain = null;
			const outcomes = chain.pending.map((p): ClaimOutcome => ({ outcome: "still_false", claim: p.claim }));
			return { result: this.result(turn, chain, outcomes, "exhausted"), feedback: null };
		}

		const outcomes: ClaimOutcome[] = [];
		const stillFalse: Pending[] = [];
		const revised = claims ?? [];
		const taken = new Set<number>();

		for (const p of chain.pending) {
			if (claims === null) {
				outcomes.push({ outcome: "still_false", claim: p.claim });
				stillFalse.push(p);
				continue;
			}
			const index = matchClaim(p.claim, revised, taken);
			const match = revised[index];
			if (!match) {
				p.entry.status = "corrected";
				p.entry.correctedBy = "retracted";
				outcomes.push({ outcome: "corrected", claim: p.claim, how: "retracted" });
				continue;
			}
			taken.add(index);
			this.update(p.entry, match);
			if (match.verdict === "verified" || match.verdict === "unverifiable") {
				const how: Correction = match.verdict;
				p.entry.status = how === "verified" ? "corrected" : "unverifiable";
				p.entry.correctedBy = how;
				outcomes.push({ outcome: "corrected", claim: p.claim, revised: match, how });
			} else {
				outcomes.push({ outcome: "still_false", claim: p.claim, revised: match });
				stillFalse.push({ entry: p.entry, claim: match });
			}
		}

		revised.forEach((claim, i) => {
			if (taken.has(i)) return;
			const entry = this.add(turn, claim, true);
			if (!isFalseClaim(claim)) return;
			outcomes.push({ outcome: "new_false", claim });
			stillFalse.push({ entry, claim });
		});

		if (stillFalse.length === 0) {
			this.chain = null;
			return { result: this.result(turn, chain, outcomes, "accepted"), feedback: null };
		}
		if (chain.round >= this.policy.maxRevisions || this.used >= this.policy.maxRevisionsPerRun) {
			this.chain = null;
			const next = chain.round >= this.policy.maxRevisions ? "exhausted" : "capped";
			return { result: this.result(turn, chain, outcomes, next), feedback: null };
		}
		const result = this.result(turn, chain, outcomes, "revise");
		chain.pending = stillFalse;
		const request = this.request(turn, chain);
		return { result, request, feedback: request.feedback };
	}

	private request(turn: number, chain: Chain): RevisionRequest {
		chain.round++;
		this.used++;
		for (const p of chain.pending) p.entry.revisions++;
		const claims = chain.pending.map((p) => p.claim);
		return {
			turn,
			originTurn: chain.originTurn,
			round: chain.round,
			maxRevisions: this.policy.maxRevisions,
			claims,
			feedback: revisionFeedback(claims, chain.round, this.policy.maxRevisions),
		};
	}

	private result(turn: number, chain: Chain, outcomes: ClaimOutcome[], next: RevisionNext): RevisionResult {
		return { turn, originTurn: chain.originTurn, round: chain.round, outcomes, next };
	}

	private add(turn: number, claim: ClaimResult, newInRevision: boolean): LedgerEntry {
		const entry: LedgerEntry = {
			turn,
			text: claim.text,
			kind: claim.kind,
			ref: claim.ref,
			firstVerdict: claim.verdict,
			verdict: claim.verdict,
			reason: claim.reason,
			status: statusOf(claim.verdict),
			revisions: 0,
			newInRevision,
		};
		this.entries.push(entry);
		return entry;
	}

	private update(entry: LedgerEntry, claim: ClaimResult): void {
		entry.verdict = claim.verdict;
		entry.reason = claim.reason;
		entry.ref = claim.ref;
		if (claim.text !== entry.text) entry.revisedText = claim.text;
	}
}

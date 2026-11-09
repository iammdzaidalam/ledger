import { describeCompaction } from "../agent/compaction.js";
import type { AgentEvent } from "../agent/types.js";
import { outcome } from "../commands/format.js";
import { formatUnverified } from "../grounding/format.js";
import type { ClaimResult, Evidence } from "../grounding/types.js";
import type {
	RevisionOutcome,
	RevisionRequest,
	RevisionResult,
	RunLedger,
	ValidationMode,
} from "../grounding/validation.js";
import type { ClaimRecord } from "../session/types.js";
import { firstLine } from "./text.js";

export type NoticeTone = "info" | "warn" | "error";

export type Entry =
	| { kind: "user"; key: number; text: string }
	| { kind: "command"; key: number; text: string }
	| { kind: "output"; key: number; text: string }
	| { kind: "notice"; key: number; tone: NoticeTone; text: string }
	| {
			kind: "assistant";
			key: number;
			run: number;
			text: string;
			streaming: boolean;
			turn?: number;
			claims: ClaimResult[];
			outcomes: Record<number, RevisionOutcome>;
	  }
	| {
			kind: "tool";
			key: number;
			run: number;
			callId: string;
			name: string;
			summary: string;
			status: "running" | "done" | "failed" | "cancelled";
			ref?: string;
			outcome?: string;
			seconds?: number;
			detail?: string;
	  }
	| { kind: "revision_request"; key: number; request: RevisionRequest }
	| { kind: "revision_result"; key: number; result: RevisionResult }
	| { kind: "ledger"; key: number; ledger: RunLedger };

export type AssistantEntry = Extract<Entry, { kind: "assistant" }>;
export type ToolEntry = Extract<Entry, { kind: "tool" }>;

export interface ClaimItem {
	key: number;
	run: number;
	turn: number;
	claim: ClaimResult;
	outcome?: RevisionOutcome;
}

export interface SessionInfo {
	id: string;
	provider: string;
	model: string;
}

export interface TuiState {
	session: SessionInfo;
	validate: ValidationMode;
	entries: Entry[];
	evidence: Evidence[];
	claims: ClaimItem[];
	running: boolean;
	run: number;
	nextKey: number;
}

export type TuiAction =
	| { type: "agent"; event: AgentEvent }
	| { type: "submit"; text: string }
	| { type: "command"; text: string }
	| { type: "output"; text: string }
	| { type: "notice"; tone: NoticeTone; text: string }
	| { type: "run_finished"; cancelled?: boolean; error?: string }
	| { type: "sync"; session: SessionInfo; evidence: Evidence[]; claims: ClaimRecord[] };

export interface InitOptions {
	session: SessionInfo;
	validate?: ValidationMode;
	evidence?: Evidence[];
	claims?: ClaimRecord[];
}

function savedClaims(records: ClaimRecord[], firstKey: number): ClaimItem[] {
	return records.flatMap((r) => r.claims).map((claim, i) => ({ key: firstKey + i, run: 0, turn: 0, claim }));
}

export function initialState(options: InitOptions): TuiState {
	const claims = savedClaims(options.claims ?? [], 1);
	return {
		session: options.session,
		validate: options.validate ?? "flag",
		entries: [],
		evidence: [...(options.evidence ?? [])],
		claims,
		running: false,
		run: 0,
		nextKey: claims.length + 1,
	};
}

type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "key"> : never) : never;

function push(state: TuiState, entry: NewEntry): TuiState {
	return {
		...state,
		entries: [...state.entries, { ...entry, key: state.nextKey } as Entry],
		nextKey: state.nextKey + 1,
	};
}

function replaceAt(state: TuiState, index: number, entry: Entry): TuiState {
	const entries = [...state.entries];
	entries[index] = entry;
	return { ...state, entries };
}

function findLast(state: TuiState, test: (e: Entry) => boolean): number {
	for (let i = state.entries.length - 1; i >= 0; i--) {
		if (test(state.entries[i] as Entry)) return i;
	}
	return -1;
}

function streamingIndex(state: TuiState): number {
	return findLast(state, (e) => e.kind === "assistant" && e.run === state.run && e.streaming);
}

export function toolSummary(input: Record<string, unknown>): string {
	for (const key of ["command", "path", "pattern", "query", "ref"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return firstLine(value);
	}
	const json = JSON.stringify(input);
	return json === "{}" ? "" : json;
}

function closeStreaming(state: TuiState): TuiState {
	const i = streamingIndex(state);
	if (i === -1) return state;
	const entry = state.entries[i] as AssistantEntry;
	if (entry.text.trim() === "") {
		return { ...state, entries: state.entries.filter((_, j) => j !== i) };
	}
	return replaceAt(state, i, { ...entry, streaming: false });
}

function sameClaim(a: ClaimResult, b: ClaimResult): boolean {
	return a.text === b.text && a.kind === b.kind;
}

function attachClaims(state: TuiState, turn: number, claims: ClaimResult[]): TuiState {
	const i = findLast(state, (e) => e.kind === "assistant" && e.run === state.run && e.turn === turn);
	const items = claims.map((claim, n) => ({ key: state.nextKey + n, run: state.run, turn, claim }));
	let next: TuiState = {
		...state,
		claims: [...state.claims, ...items],
		nextKey: state.nextKey + claims.length,
	};
	if (i !== -1) {
		const entry = state.entries[i] as AssistantEntry;
		next = replaceAt(next, i, { ...entry, claims: [...entry.claims, ...claims] });
	}
	return next;
}

function applyOutcomes(state: TuiState, result: RevisionResult): TuiState {
	let next = state;
	const claims = [...next.claims];
	const entries = [...next.entries];
	for (const o of result.outcomes) {
		if (o.outcome === "new_false") continue;
		for (let i = claims.length - 1; i >= 0; i--) {
			const item = claims[i] as ClaimItem;
			if (item.run !== state.run || item.outcome || !sameClaim(item.claim, o.claim)) continue;
			claims[i] = { ...item, outcome: o.outcome };
			break;
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as Entry;
			if (entry.kind !== "assistant" || entry.run !== state.run) continue;
			const n = entry.claims.findIndex((c, k) => entry.outcomes[k] === undefined && sameClaim(c, o.claim));
			if (n === -1) continue;
			entries[i] = { ...entry, outcomes: { ...entry.outcomes, [n]: o.outcome } };
			break;
		}
	}
	next = { ...next, claims, entries };
	return next;
}

function finishTools(state: TuiState, status: "cancelled"): TuiState {
	if (!state.entries.some((e) => e.kind === "tool" && e.status === "running")) return state;
	return {
		...state,
		entries: state.entries.map((e) => (e.kind === "tool" && e.status === "running" ? { ...e, status } : e)),
	};
}

function onAgentEvent(state: TuiState, event: AgentEvent): TuiState {
	switch (event.type) {
		case "text_delta": {
			const i = streamingIndex(state);
			if (i === -1) {
				return push(state, {
					kind: "assistant",
					run: state.run,
					text: event.delta,
					streaming: true,
					claims: [],
					outcomes: {},
				});
			}
			const entry = state.entries[i] as AssistantEntry;
			return replaceAt(state, i, { ...entry, text: entry.text + event.delta });
		}
		case "assistant_turn": {
			const i = streamingIndex(state);
			if (i === -1) {
				if (!event.text) return state;
				return push(state, {
					kind: "assistant",
					run: state.run,
					text: event.text,
					streaming: false,
					turn: event.turn,
					claims: [],
					outcomes: {},
				});
			}
			const entry = state.entries[i] as AssistantEntry;
			if (!event.text) return { ...state, entries: state.entries.filter((_, j) => j !== i) };
			return replaceAt(state, i, { ...entry, text: event.text, streaming: false, turn: event.turn });
		}
		case "grounding_check": {
			let next = attachClaims(state, event.turn, event.claims);
			if (event.error)
				next = push(next, { kind: "notice", tone: "warn", text: `Checker error: ${event.error}` });
			return next;
		}
		case "grounding_flag": {
			const known = state.claims.some((c) => c.run === state.run && sameClaim(c.claim, event.claim));
			if (known) return state;
			const i = findLast(state, (e) => e.kind === "assistant" && e.run === state.run);
			const turn = i === -1 ? 0 : ((state.entries[i] as AssistantEntry).turn ?? 0);
			return attachClaims(state, turn, [event.claim]);
		}
		case "grounding_revision_requested": {
			const { type: _, ...request } = event;
			return push(state, { kind: "revision_request", request });
		}
		case "grounding_revision_result": {
			const { type: _, ...result } = event;
			return push(applyOutcomes(state, result), { kind: "revision_result", result });
		}
		case "tool_start":
			return push(closeStreaming(state), {
				kind: "tool",
				run: state.run,
				callId: event.id,
				name: event.name,
				summary: toolSummary(event.input),
				status: "running",
			});
		case "evidence": {
			const next = { ...state, evidence: [...state.evidence, event.entry] };
			const i = event.toolUseId
				? findLast(next, (e) => e.kind === "tool" && e.callId === event.toolUseId && e.run === state.run)
				: findLast(next, (e) => e.kind === "tool" && e.status === "running");
			if (i === -1) return next;
			const entry = next.entries[i] as ToolEntry;
			return replaceAt(next, i, {
				...entry,
				ref: event.entry.ref,
				outcome: outcome(event.entry),
				seconds: event.entry.executed ? event.entry.duration_ms / 1000 : undefined,
			});
		}
		case "tool_end": {
			const i = findLast(state, (e) => e.kind === "tool" && e.callId === event.id && e.run === state.run);
			if (i === -1) return state;
			const entry = state.entries[i] as ToolEntry;
			const failed =
				event.isError ||
				(entry.outcome !== undefined && /^exit [1-9]|timed out|not run|failed/.test(entry.outcome));
			return replaceAt(state, i, {
				...entry,
				status: failed ? "failed" : "done",
				outcome: entry.outcome ?? (event.isError ? "failed" : undefined),
				detail: event.isError && !entry.ref ? firstLine(event.result) : undefined,
			});
		}
		case "compaction":
			return push(state, { kind: "notice", tone: "info", text: describeCompaction(event.compaction) });
		case "agent_end": {
			let next = closeStreaming(state);
			const ledger = event.ledger;
			if (ledger && (ledger.entries.length > 0 || ledger.checkerErrors > 0)) {
				next = push(next, { kind: "ledger", ledger });
			}
			if (ledger && next.validate === "strict" && ledger.unverified) {
				next = push(next, { kind: "notice", tone: "error", text: formatUnverified(ledger) });
			}
			return next;
		}
		default:
			return state;
	}
}

export function reduce(state: TuiState, action: TuiAction): TuiState {
	switch (action.type) {
		case "agent":
			return onAgentEvent(state, action.event);
		case "submit":
			return { ...push(state, { kind: "user", text: action.text }), running: true, run: state.run + 1 };
		case "command":
			return push(state, { kind: "command", text: action.text });
		case "output":
			return push(state, { kind: "output", text: action.text });
		case "notice":
			return push(state, { kind: "notice", tone: action.tone, text: action.text });
		case "run_finished": {
			let next: TuiState = { ...finishTools(closeStreaming(state), "cancelled"), running: false };
			if (action.cancelled) next = push(next, { kind: "notice", tone: "info", text: "Cancelled." });
			if (action.error) next = push(next, { kind: "notice", tone: "error", text: action.error });
			return next;
		}
		case "sync": {
			if (action.session.id !== state.session.id) {
				const claims = savedClaims(action.claims, state.nextKey);
				return {
					...state,
					session: action.session,
					evidence: [...action.evidence],
					claims,
					nextKey: state.nextKey + claims.length,
				};
			}
			const evidence =
				action.evidence.length >= state.evidence.length ? [...action.evidence] : state.evidence;
			return { ...state, session: action.session, evidence };
		}
	}
}

export interface Tally {
	verified: number;
	corrected: number;
	false: number;
	unverifiable: number;
}

export function tally(claims: readonly ClaimItem[]): Tally {
	const t: Tally = { verified: 0, corrected: 0, false: 0, unverifiable: 0 };
	for (const { claim, outcome } of claims) {
		if (outcome === "corrected") t.corrected++;
		else if (claim.verdict === "verified") t.verified++;
		else if (claim.verdict === "unverifiable") t.unverifiable++;
		else t.false++;
	}
	return t;
}

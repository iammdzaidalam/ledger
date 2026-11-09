import type { ClaimResult, Evidence } from "../grounding/types.js";
import type { Message } from "../types.js";

export type SessionEntry =
	| { type: "meta"; timestamp: string; provider: string; model: string }
	| { type: "message"; timestamp: string; message: Message }
	| { type: "evidence"; timestamp: string; entry: Evidence }
	| { type: "claims"; timestamp: string; claims: ClaimResult[] }
	| { type: "compaction"; timestamp: string; summary: string; keep: number }
	| { type: "clear"; timestamp: string };

export type NewSessionEntry = SessionEntry extends infer E
	? E extends SessionEntry
		? Omit<E, "timestamp">
		: never
	: never;

export interface ClaimRecord {
	timestamp: string;
	claims: ClaimResult[];
}

export interface SessionData {
	id: string;
	path: string;
	provider?: string;
	model?: string;
	createdAt?: string;
	updatedAt?: string;
	messages: Message[];
	messageCount: number;
	evidence: Evidence[];
	claims: ClaimRecord[];
}

export interface SessionSummary {
	id: string;
	updatedAt: Date;
	provider?: string;
	model?: string;
	messages: number;
	evidence: number;
	flagged: number;
	firstPrompt: string;
}

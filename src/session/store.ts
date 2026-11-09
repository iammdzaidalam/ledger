import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withSummary } from "../agent/compaction.js";
import type { Message } from "../types.js";
import type { NewSessionEntry, SessionData, SessionEntry, SessionSummary } from "./types.js";

export function sessionsDir(cwd = process.cwd()): string {
	return join(cwd, ".ledger", "sessions");
}

export function sessionPath(id: string, cwd = process.cwd()): string {
	return join(sessionsDir(cwd), `${id}.jsonl`);
}

export function defaultSessionId(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

export async function appendEntry(path: string, entry: NewSessionEntry): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
	await appendFile(path, `${line}\n`, "utf-8");
}

function toEntry(raw: unknown): SessionEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.type === "string") return value as unknown as SessionEntry;
	if (value.message && typeof value.message === "object") {
		return { type: "message", timestamp: String(value.timestamp ?? ""), message: value.message as Message };
	}
	return undefined;
}

export async function readEntries(path: string): Promise<SessionEntry[]> {
	const raw = await readFile(path, "utf-8");
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = toEntry(JSON.parse(line));
			if (entry) entries.push(entry);
		} catch {}
	}
	return entries;
}

export function replay(id: string, path: string, entries: SessionEntry[]): SessionData {
	const data: SessionData = { id, path, messages: [], messageCount: 0, evidence: [], claims: [] };
	for (const entry of entries) {
		data.createdAt ??= entry.timestamp;
		data.updatedAt = entry.timestamp;
		if (entry.type === "meta") {
			data.provider = entry.provider;
			data.model = entry.model;
		} else if (entry.type === "message") {
			data.messages.push(entry.message);
			data.messageCount++;
		} else if (entry.type === "evidence") {
			data.evidence.push(entry.entry);
		} else if (entry.type === "claims") {
			data.claims.push({ timestamp: entry.timestamp, claims: entry.claims });
		} else if (entry.type === "compaction") {
			const recent = entry.keep > 0 ? data.messages.slice(-entry.keep) : [];
			data.messages = withSummary(entry.summary, recent);
		} else if (entry.type === "clear") {
			data.messages = [];
		}
	}
	return data;
}

export async function loadSession(id: string, cwd = process.cwd()): Promise<SessionData | null> {
	const path = sessionPath(id, cwd);
	try {
		return replay(id, path, await readEntries(path));
	} catch {
		return null;
	}
}

async function sessionIds(cwd: string): Promise<string[]> {
	try {
		const files = await readdir(sessionsDir(cwd));
		return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
	} catch {
		return [];
	}
}

function firstPrompt(messages: Message[]): string {
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text =
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join(" ");
		if (text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 70);
	}
	return "";
}

export async function listSessions(cwd = process.cwd()): Promise<SessionSummary[]> {
	const summaries: SessionSummary[] = [];
	for (const id of await sessionIds(cwd)) {
		const path = sessionPath(id, cwd);
		try {
			const [entries, info] = await Promise.all([readEntries(path), stat(path)]);
			const data = replay(id, path, entries);
			const allMessages = entries.flatMap((e) => (e.type === "message" ? [e.message] : []));
			summaries.push({
				id,
				updatedAt: info.mtime,
				provider: data.provider,
				model: data.model,
				messages: data.messageCount,
				evidence: data.evidence.length,
				flagged: data.claims.flatMap((r) => r.claims).filter((c) => c.verdict !== "verified").length,
				firstPrompt: firstPrompt(allMessages),
			});
		} catch {}
	}
	return summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function latestSessionId(cwd = process.cwd()): Promise<string | undefined> {
	return (await listSessions(cwd))[0]?.id;
}

export async function resolveSessionId(query: string, cwd = process.cwd()): Promise<string> {
	const ids = await sessionIds(cwd);
	if (ids.includes(query)) return query;
	const matches = ids.filter((id) => id.startsWith(query));
	const [only] = matches;
	if (only && matches.length === 1) return only;
	if (matches.length === 0)
		throw new Error(`No saved session matches "${query}". Run ledger sessions to list them.`);
	throw new Error(`"${query}" matches ${matches.length} sessions. Use more of the id.`);
}

export function formatSessionList(sessions: SessionSummary[], limit = 20): string {
	if (sessions.length === 0) return "No saved sessions in .ledger/sessions yet.";
	const rows = sessions.slice(0, limit).map((s) => {
		const when = s.updatedAt.toISOString().slice(0, 16).replace("T", " ");
		const model = s.provider && s.model ? `${s.provider}/${s.model}` : "unknown model";
		const flagged = s.flagged > 0 ? `, ${s.flagged} flagged` : "";
		const prompt = s.firstPrompt ? `  "${s.firstPrompt}"` : "";
		return `${s.id}  ${when}  ${model}  ${s.messages} msgs, ${s.evidence} evidence${flagged}${prompt}`;
	});
	const more = sessions.length > limit ? `\n... and ${sessions.length - limit} older` : "";
	return `${rows.join("\n")}${more}`;
}

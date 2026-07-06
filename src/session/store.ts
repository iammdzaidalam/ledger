import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "../types.js";
import type { SessionEntry } from "./types.js";

// Sessions are append-only JSONL, one message per line. Simple to append to
// mid-run and simple to reconstruct, no compaction or resume logic yet.
export async function appendMessage(sessionPath: string, message: Message): Promise<void> {
	await mkdir(dirname(sessionPath), { recursive: true });
	const entry: SessionEntry = { timestamp: new Date().toISOString(), message };
	await appendFile(sessionPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function readSession(sessionPath: string): Promise<Message[]> {
	try {
		const raw = await readFile(sessionPath, "utf-8");
		return raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => (JSON.parse(line) as SessionEntry).message);
	} catch {
		return [];
	}
}

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ClaimKind, ClaimResult, ClaimsMode, Evidence } from "../../src/grounding/types.js";

export interface Scenario {
	id: string;
	split: "dev" | "test";
	category: "trap" | "control" | "open";
	prompt: string;
	setup: string[];
	truth: string;
	verify: string | null;
}

export interface SessionMeta {
	type: "meta";
	session: string;
	scenario: string;
	split: Scenario["split"];
	category: Scenario["category"];
	prompt: string;
	provider: string;
	model: string;
	model_digest: string | null;
	claims_mode: ClaimsMode;
	seed: number;
	temperature: number;
	num_ctx: number;
	num_predict: number;
	max_turns: number;
	ledger_commit: string;
	started_at: string;
}

export type TraceLine =
	| SessionMeta
	| { type: "turn"; turn: number; text: string; tool_calls: number }
	| {
			type: "tool";
			turn: number;
			name: string;
			input: Record<string, unknown>;
			output: string;
			is_error: boolean;
	  }
	| { type: "evidence"; turn: number; entry: Evidence }
	| { type: "check"; turn: number; claims: ClaimResult[]; latency_ms: number; error?: string }
	| { type: "verify"; command: string; exit_code: number | null; output: string }
	| { type: "end"; turns: number; duration_ms: number; error?: string };

export interface TurnView {
	session: string;
	turn: number;
	text: string;
	evidence: Evidence[];
	fresh: string[];
	recorded: ClaimResult[];
}

export interface Session {
	file: string;
	meta: SessionMeta;
	lines: TraceLine[];
	turns: TurnView[];
	verify?: Extract<TraceLine, { type: "verify" }>;
}

export const LABEL_KINDS: ClaimKind[] = [
	"tests_pass",
	"file_created",
	"bug_fixed",
	"lint_clean",
	"command_success",
];

export function parseTrace(file: string, raw: string): Session {
	const lines = raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as TraceLine);
	const meta = lines[0];
	if (meta?.type !== "meta") throw new Error(`${file}: first line is not meta`);

	const evidence: Evidence[] = [];
	let fresh: string[] = [];
	const turns: TurnView[] = [];
	for (const line of lines) {
		if (line.type === "evidence") {
			evidence.push(line.entry);
			fresh.push(line.entry.ref);
		}
		if (line.type === "turn" && line.text) {
			turns.push({
				session: meta.session,
				turn: line.turn,
				text: line.text,
				evidence: [...evidence],
				fresh,
				recorded: [],
			});
			fresh = [];
		}
		if (line.type === "check") {
			const view = turns.find((t) => t.turn === line.turn);
			if (view) view.recorded = line.claims;
		}
	}
	const verify = lines.find((l): l is Extract<TraceLine, { type: "verify" }> => l.type === "verify");
	return { file, meta, lines, turns, verify };
}

export async function loadSessions(dir: string): Promise<Session[]> {
	const files = await walk(dir);
	const sessions: Session[] = [];
	for (const file of files.filter((f) => f.endsWith(".jsonl")).sort()) {
		sessions.push(parseTrace(relative(process.cwd(), file), await readFile(file, "utf-8")));
	}
	return sessions;
}

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const out: string[] = [];
	for (const e of entries) {
		const path = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(path)));
		else out.push(path);
	}
	return out;
}

export async function loadScenarios(dir = join(import.meta.dirname, "..", "scenarios")): Promise<Scenario[]> {
	const ids = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	return Promise.all(
		ids
			.sort()
			.map(async (id) => JSON.parse(await readFile(join(dir, id, "scenario.json"), "utf-8")) as Scenario),
	);
}

export function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : fallback;
}

export function list(name: string, fallback: string): string[] {
	return (arg(name, fallback) ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Evidence } from "../src/grounding/types.js";
import { arg, type SessionMeta, type TraceLine } from "./lib/trace.js";

const DATASET = "nebius/SWE-rebench-openhands-trajectories";
const MODEL = "Qwen3-Coder-480B-A35B-Instruct";
const ROWS = "https://datasets-server.huggingface.co/rows";

const count = Number(arg("count", "200"));
const seed = Number(arg("seed", "11"));
const out = resolve(arg("out", join("eval", "traces", "openhands")) as string);
const exclude = arg("exclude");

interface ToolCall {
	id: string;
	function: { name: string; arguments: string };
}

interface Message {
	role: string;
	content: string | null;
	name?: string | null;
	tool_call_id?: string | null;
	tool_calls?: ToolCall[] | null;
}

interface Row {
	trajectory_id: string;
	instance_id: string;
	repo: string;
	trajectory: Message[];
	resolved: number;
}

const EXIT = /\[Command finished with exit code (-?\d+)\]/g;
const TRAILER =
	/^\[(The command completed|Command finished|Python interpreter|Current working directory|Below is the output)[^\n]*\]?$/gm;

function offsets(total: number, n: number, start: number): number[] {
	const picked = new Set<number>();
	let s = start;
	while (picked.size < Math.min(n, total)) {
		s = (s * 1103515245 + 12345) % 2147483648;
		picked.add(s % total);
	}
	return [...picked];
}

async function fetchRows(offset: number, length: number): Promise<{ rows: Row[]; total: number }> {
	const url = `${ROWS}?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${offset}&length=${length}`;
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(url);
		if (res.ok) {
			const body = (await res.json()) as { rows: { row: Row }[]; num_rows_total: number };
			return { rows: body.rows.map((r) => r.row), total: body.num_rows_total };
		}
		if (attempt >= 8) throw new Error(`${url} -> ${res.status}`);
		const wait = res.status === 429 ? 15000 * attempt : 2000 * attempt;
		await new Promise((r) => setTimeout(r, wait));
	}
}

function parseArgs(call: ToolCall): Record<string, unknown> {
	try {
		return JSON.parse(call.function.arguments) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function clip(s: string, head = 2000, tail = 6000): string {
	return s.length > head + tail ? `${s.slice(0, head)}\n[clipped]\n${s.slice(-tail)}` : s;
}

function evidenceFor(call: ToolCall, result: string | undefined, ref: number): Evidence | null {
	const args = parseArgs(call);
	const base = { ref: `c${ref}`, seq: ref, duration_ms: 0 };
	if (call.function.name === "execute_bash") {
		if (args.is_input === true || args.is_input === "true") return null;
		const command = String(args.command ?? "");
		if (result === undefined) {
			return {
				...base,
				tool: "Bash",
				args: { command },
				raw_stdout: "",
				raw_stderr: "",
				exit_code: null,
				executed: false,
				is_error: true,
			};
		}
		const codes = [...result.matchAll(EXIT)];
		const exit = codes.length ? Number(codes.at(-1)?.[1]) : null;
		return {
			...base,
			tool: "Bash",
			args: { command },
			raw_stdout: clip(result.replace(TRAILER, "").trim()),
			raw_stderr: "",
			exit_code: exit,
			executed: true,
			is_error: exit !== 0,
		};
	}
	if (call.function.name !== "str_replace_editor") return null;
	const command = String(args.command ?? "");
	const path = String(args.path ?? "");
	const text = result ?? "";
	if (command === "create") {
		const ok = text.startsWith("File created successfully");
		const body = String(args.file_text ?? "").split("\n");
		const diff = ok ? `@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join("\n")}` : "";
		return {
			...base,
			tool: "Write",
			args: { path },
			raw_stdout: ok ? text : "",
			raw_stderr: ok ? "" : text,
			exit_code: null,
			executed: true,
			is_error: !ok,
			diff: clip(diff),
		};
	}
	if (command === "str_replace" || command === "insert" || command === "undo_edit") {
		const ok = /has been edited|successfully|undone/i.test(text) && !/^ERROR/i.test(text);
		const removed = command === "str_replace" ? String(args.old_str ?? "") : "";
		const added = String(args.new_str ?? "");
		const diff =
			ok && command !== "undo_edit"
				? `@@ @@\n${removed
						.split("\n")
						.map((l) => `-${l}`)
						.join("\n")}\n${added
						.split("\n")
						.map((l) => `+${l}`)
						.join("\n")}`
				: "";
		return {
			...base,
			tool: "Edit",
			args: { path },
			raw_stdout: ok ? clip(text, 500, 500) : "",
			raw_stderr: ok ? "" : text,
			exit_code: null,
			executed: true,
			is_error: !ok,
			diff: clip(diff),
		};
	}
	return null;
}

function convert(row: Row): { session: string; lines: TraceLine[] } {
	const session = `${row.instance_id}__${row.trajectory_id.slice(-8)}`;
	const results = new Map<string, string>();
	for (const m of row.trajectory)
		if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content ?? "");
	const meta: SessionMeta & { resolved: number; source: string } = {
		type: "meta",
		session,
		scenario: row.instance_id,
		split: "external",
		category: "open",
		prompt: clip(row.trajectory.find((m) => m.role === "user")?.content ?? "", 1500, 500),
		provider: "openhands",
		model: MODEL,
		model_digest: null,
		claims_mode: "prose",
		seed: 0,
		temperature: 0,
		num_ctx: 0,
		num_predict: 0,
		max_turns: 0,
		ledger_commit: "external",
		started_at: "",
		resolved: row.resolved,
		source: `${DATASET}#${row.trajectory_id}`,
	};
	const lines: TraceLine[] = [meta];
	let turn = 0;
	let ref = 0;
	for (const m of row.trajectory) {
		if (m.role !== "assistant") continue;
		turn++;
		const calls = m.tool_calls ?? [];
		const finish = calls.find((c) => c.function.name === "finish");
		const closing = finish ? String(parseArgs(finish).message ?? "") : "";
		const text = [m.content ?? "", closing]
			.map((s) => s.trim())
			.filter(Boolean)
			.join("\n\n");
		lines.push({ type: "turn", turn, text, tool_calls: calls.length });
		for (const call of calls) {
			const entry = evidenceFor(call, results.get(call.id), ref + 1);
			if (!entry) continue;
			ref++;
			lines.push({ type: "evidence", turn, entry });
		}
	}
	return { session, lines };
}

const { total } = await fetchRows(0, 1);
const taken = new Set(
	exclude ? (await readFile(exclude, "utf-8")).split("\n").filter(Boolean).map(Number) : [],
);
const picks = offsets(total, count + taken.size, seed)
	.filter((o) => !taken.has(o))
	.slice(0, count)
	.sort((a, b) => a - b);
await mkdir(out, { recursive: true });
const manifest = join(out, "offsets.txt");
const done = new Set(
	(await readFile(manifest, "utf-8").catch(() => "")).split("\n").filter(Boolean).map(Number),
);
let turns = 0;
let failed = 0;
for (const [i, offset] of picks.entries()) {
	if (done.has(offset)) continue;
	try {
		const { rows } = await fetchRows(offset, 1);
		const row = rows[0];
		if (!row) continue;
		const { session, lines } = convert(row);
		turns += lines.filter((l) => l.type === "turn" && "text" in l && l.text).length;
		await writeFile(join(out, `${session}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		await appendFile(manifest, `${offset}\n`);
	} catch (err) {
		failed++;
		console.error(`offset ${offset}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if ((i + 1) % 25 === 0) console.log(`${i + 1}/${picks.length} trajectories, ${turns} new turns with text`);
}
console.log(
	`${picks.length - failed} of ${picks.length} trajectories from ${DATASET} (${total} rows), ${turns} new turns -> ${out}`,
);

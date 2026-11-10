import sandboxJson from "../data/sandbox.json";
import type { CheckRequest, CheckResponse, EvidenceEntry } from "./checker";

export interface Preset {
	id: string;
	title: string;
	prompt: string;
	model: string;
	session: string;
	source: string;
	turn: number;
	message: string;
	written: boolean;
	added: string;
	evidence: EvidenceEntry[];
	recorded: { kind: string; verdict: string }[];
}

export const PRESETS = sandboxJson as Preset[];

export const HERO_EVIDENCE: EvidenceEntry[] = [
	{
		ref: "c1",
		seq: 1,
		tool: "Bash",
		args: { command: "npm test" },
		raw_stdout: "\n> app@1.0.0 test\n> vitest run\n\n Test Files  1 failed (1)\n      Tests  2 failed | 5 passed (7)\n",
		raw_stderr: "",
		exit_code: 1,
		executed: true,
		is_error: true,
		duration_ms: 812,
	},
];

export const HERO_LINES = ["All tests pass.", "The test run showed two failures.", "I fixed the bug and the suite is green."];

export interface Row {
	id: string;
	ref: string;
	tool: string;
	target: string;
	exit: string;
	failed: boolean;
	ran: boolean;
	stdout: string;
	stderr: string;
	diff: string;
}

export interface SandboxState {
	preset: string | null;
	message: string;
	rows: Row[];
}

export const TOOLS = ["Bash", "Write", "Edit", "Read", "Find"];

function str(v: unknown): string {
	return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

export function rowsFromEvidence(evidence: EvidenceEntry[], prefix = "p"): Row[] {
	return evidence.map((e, i) => {
		const bash = e.tool === "Bash" || e.tool === "Git";
		return {
			id: `${prefix}${i}`,
			ref: e.ref,
			tool: e.tool,
			target: bash ? str(e.args.command) : str(e.args.path ?? e.args.pattern),
			exit: bash && e.exit_code !== null && e.exit_code !== undefined ? String(e.exit_code) : "0",
			failed: !bash && e.is_error,
			ran: e.executed,
			stdout: e.raw_stdout ?? "",
			stderr: e.raw_stderr ?? "",
			diff: e.diff ?? "",
		};
	});
}

export function evidenceFromRows(rows: Row[]): EvidenceEntry[] {
	return rows.map((r, i) => {
		const bash = r.tool === "Bash";
		const code = Number.parseInt(r.exit, 10);
		const exit = bash && r.ran ? (Number.isFinite(code) ? code : 0) : null;
		return {
			ref: r.ref,
			seq: i + 1,
			tool: r.tool,
			args: bash ? { command: r.target } : r.tool === "Find" ? { pattern: r.target } : { path: r.target },
			raw_stdout: r.stdout,
			raw_stderr: r.stderr,
			exit_code: exit,
			executed: r.ran,
			is_error: bash ? exit !== null && exit !== 0 : r.failed,
			duration_ms: 0,
			diff: r.diff,
		};
	});
}

export function toRequest(state: Pick<SandboxState, "message" | "rows">): CheckRequest {
	const evidence = evidenceFromRows(state.rows);
	return { turn_text: state.message, evidence, fresh_refs: evidence.map((e) => e.ref) };
}

export function presetState(id: string): SandboxState {
	const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
	return { preset: p.id, message: p.message, rows: rowsFromEvidence(p.evidence) };
}

export function nextRef(rows: Row[]): string {
	let max = 0;
	for (const r of rows) {
		const m = r.ref.match(/^c(\d+)$/);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `c${max + 1}`;
}

export function sameState(a: SandboxState, b: SandboxState): boolean {
	const key = (s: SandboxState) => JSON.stringify([s.message, evidenceFromRows(s.rows)]);
	return key(a) === key(b);
}

function b64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(text: string): string {
	const pad = text.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeState(state: SandboxState): string {
	const preset = state.preset ? presetState(state.preset) : null;
	if (preset && sameState(state, preset)) return `try=${state.preset}`;
	const rows = state.rows.map((r) => [r.ref, r.tool, r.target, r.exit, r.failed ? 1 : 0, r.ran ? 1 : 0, r.stdout, r.stderr, r.diff]);
	return `try=${b64(JSON.stringify({ m: state.message, r: rows }))}`;
}

export function decodeState(hash: string): SandboxState | null {
	const m = hash.replace(/^#/, "").match(/^try=(.+)$/);
	if (!m) return null;
	const value = m[1];
	if (PRESETS.some((p) => p.id === value)) return presetState(value);
	try {
		const data = JSON.parse(unb64(value)) as { m: string; r: unknown[][] };
		const rows: Row[] = data.r.map((c, i) => ({
			id: `h${i}`,
			ref: str(c[0]),
			tool: str(c[1]),
			target: str(c[2]),
			exit: str(c[3]),
			failed: c[4] === 1,
			ran: c[5] !== 0,
			stdout: str(c[6]),
			stderr: str(c[7]),
			diff: str(c[8]),
		}));
		return { preset: null, message: str(data.m), rows };
	} catch {
		return null;
	}
}

export type Initial = Record<string, CheckResponse>;

export function computeInitial(run: (req: CheckRequest) => CheckResponse | null): Initial {
	const out: Initial = {};
	for (const p of PRESETS) {
		const r = run(toRequest(presetState(p.id)));
		if (r) out[p.id] = r;
	}
	for (const line of HERO_LINES) {
		const r = run({ turn_text: line, evidence: HERO_EVIDENCE, fresh_refs: ["c1"] });
		if (r) out[`hero:${line}`] = r;
	}
	return out;
}

export function readInitial(): Initial {
	if (typeof document === "undefined") return (globalThis as { __ledgerInitial?: Initial }).__ledgerInitial ?? {};
	const el = document.getElementById("ledger-initial");
	if (!el?.textContent) return {};
	try {
		return JSON.parse(el.textContent) as Initial;
	} catch {
		return {};
	}
}

import { outcome } from "../commands/format.js";
import type { SlashCommand } from "../commands/registry.js";
import type { Evidence } from "../grounding/types.js";
import type { LedgerEntry, RevisionResult, RunLedger } from "../grounding/validation.js";
import { renderMarkdown } from "./markdown.js";
import type { AssistantEntry, ClaimItem, Entry, ToolEntry, TuiState } from "./state.js";
import { tally } from "./state.js";
import {
	clip,
	type Line,
	lineWidth,
	padLine,
	type Segment,
	type Style,
	sanitize,
	seg,
	truncateLine,
	wrap,
} from "./text.js";
import { annotate, isFalse, stripClaimTags, verdictHooks, verdictMark } from "./verdicts.js";

const INDENT = 2;
const DIM: Style = { dim: true };
const ACCENT: Style = { tone: "accent" };
const BAD: Style = { tone: "bad" };

function plain(text: string, width: number, style?: Style, indent = INDENT): Line[] {
	const pad = [seg(" ".repeat(indent))];
	return sanitize(text)
		.split("\n")
		.flatMap((row) => wrap([seg(row, style)], width, { prefix: pad, indent }));
}

export function assistantLines(entry: AssistantEntry, width: number): Line[] {
	const display = stripClaimTags(entry.text);
	if (entry.claims.length === 0) return renderMarkdown(display, width, undefined, INDENT);
	const { text, unplaced } = annotate(display, entry.claims);
	const lines = renderMarkdown(text, width, verdictHooks(entry.claims, entry.outcomes), INDENT);
	for (const i of unplaced) {
		const claim = entry.claims[i];
		if (!claim) continue;
		const quoted = seg(`"${clip(claim.text, 80)}"`, isFalse(claim) ? { underline: true } : DIM);
		lines.push(
			...wrap([quoted, ...verdictMark(claim, entry.outcomes[i])], width, {
				prefix: [seg("  ↳ ", DIM)],
				indent: 4,
			}),
		);
	}
	return lines;
}

function toolLine(entry: ToolEntry, width: number): Line[] {
	const glyph: Record<ToolEntry["status"], Segment> = {
		running: seg("○ ", DIM),
		done: seg("● ", ACCENT),
		failed: seg("● ", { bold: true }),
		cancelled: seg("○ ", DIM),
	};
	const tail: Segment[] = [];
	if (entry.ref) tail.push(seg(entry.ref, ACCENT));
	if (entry.status === "running") tail.push(seg("running", DIM));
	if (entry.status === "cancelled") tail.push(seg("cancelled", DIM));
	if (entry.outcome) tail.push(seg(entry.outcome, entry.status === "failed" ? { bold: true } : DIM));
	if (entry.seconds !== undefined) tail.push(seg(`${entry.seconds.toFixed(1)}s`, DIM));
	const joined: Segment[] = tail.flatMap((s, i) => (i === 0 ? [s] : [seg(" · ", DIM), s]));
	const head: Segment[] = [seg("  "), glyph[entry.status], seg(entry.name, { bold: true })];
	const tailWidth = lineWidth(joined) + 2;
	const room = Math.max(8, width - lineWidth(head) - tailWidth - 1);
	const summary = entry.summary ? [seg(" "), seg(clip(sanitize(entry.summary), room))] : [];
	const line = truncateLine([...head, ...summary, seg("  "), ...joined], width);
	const lines = [line];
	if (entry.detail) lines.push(truncateLine([seg("    "), seg(sanitize(entry.detail), DIM)], width));
	return lines;
}

function revisionRequestLines(entry: Extract<Entry, { kind: "revision_request" }>, width: number): Line[] {
	const r = entry.request;
	const n = r.claims.length;
	const head = `↻ Sent ${n} claim${n === 1 ? "" : "s"} back for revision (round ${r.round} of ${r.maxRevisions})`;
	const lines = wrap([seg(head, ACCENT)], width, { prefix: [seg("  ")], indent: 4 });
	for (const c of r.claims) {
		const source = c.ref ? `${c.verdict} by ${c.ref}` : `${c.verdict}, no evidence`;
		lines.push(
			...wrap([seg(`"${clip(c.text, 80)}" `, DIM), seg(source, BAD)], width, {
				prefix: [seg("    - ", DIM)],
				indent: 6,
			}),
		);
	}
	return lines;
}

const NEXT: Record<RevisionResult["next"], string> = {
	accepted: "all corrected",
	revise: "revising again",
	exhausted: "out of revisions",
	capped: "run revision cap reached",
	ended: "run ended before a revised answer",
};

function revisionResultLines(result: RevisionResult, width: number): Line[] {
	const count = (o: string) => result.outcomes.filter((x) => x.outcome === o).length;
	const parts: Segment[] = [seg(`↻ Revision ${result.round}: `, ACCENT)];
	parts.push(seg(`${count("corrected")} corrected`, ACCENT));
	const still = count("still_false");
	parts.push(seg(", "), seg(`${still} still false`, still > 0 ? { ...BAD, bold: true } : DIM));
	const fresh = count("new_false");
	if (fresh > 0) parts.push(seg(", "), seg(`${fresh} new false`, { ...BAD, bold: true }));
	parts.push(seg(` · ${NEXT[result.next]}`, DIM));
	return wrap(parts, width, { prefix: [seg("  ")], indent: 4 });
}

const STATUS_STYLE: Record<LedgerEntry["status"], Style> = {
	verified: {},
	corrected: ACCENT,
	false: { ...BAD, bold: true },
	unverifiable: DIM,
};

function ledgerDetail(e: LedgerEntry): string {
	if (e.status === "corrected" && e.correctedBy === "retracted") return "retracted";
	if (e.status === "corrected")
		return e.revisedText ? `now verified: "${clip(e.revisedText, 60)}"` : "now verified";
	if (e.status === "false") {
		const tried = e.revisions > 0 ? ` after ${e.revisions} revision${e.revisions === 1 ? "" : "s"}` : "";
		return `${e.verdict}${tried}: ${e.reason}`;
	}
	if (e.status === "unverifiable") return e.reason;
	return "";
}

export function ledgerLines(ledger: RunLedger, width: number): Line[] {
	const count = (s: LedgerEntry["status"]) => ledger.entries.filter((e) => e.status === s).length;
	const n = ledger.entries.length;
	const head: Segment[] = [
		seg("  "),
		seg("Ledger", { bold: true }),
		seg(`  ${n} claim${n === 1 ? "" : "s"} · ${count("verified")} verified · `, DIM),
		seg(`${count("corrected")} corrected`, count("corrected") > 0 ? ACCENT : DIM),
		seg(" · ", DIM),
		seg(`${count("false")} false`, count("false") > 0 ? { ...BAD, bold: true } : DIM),
		seg(` · ${count("unverifiable")} unverifiable`, DIM),
	];
	if (ledger.revisionsRequested > 0) head.push(seg(` · ${ledger.revisionsRequested} revision(s)`, DIM));
	if (ledger.checkerErrors > 0) head.push(seg(` · ${ledger.checkerErrors} checker error(s)`, { bold: true }));
	const lines = wrap(head, width, { indent: 4 });
	const kindWidth = Math.max(0, ...ledger.entries.map((e) => e.kind.length));
	for (const e of ledger.entries) {
		const where = `t${e.turn}${e.ref ? ` ${e.ref}` : ""}`.padEnd(7);
		const label = (e.status === "false" ? "FALSE" : e.status).padEnd(12);
		const row: Segment[] = [
			seg("  "),
			seg(label, STATUS_STYLE[e.status]),
			seg(`${where} ${e.kind.padEnd(kindWidth)}  `, DIM),
			seg(`"${clip(e.text, 70)}"`),
		];
		lines.push(truncateLine(row, width));
		const detail = ledgerDetail(e);
		if (detail) {
			const style = e.status === "false" ? BAD : DIM;
			lines.push(...wrap([seg(detail, style)], width, { prefix: [seg(" ".repeat(16))], indent: 16 }));
		}
	}
	return lines;
}

export function entryLines(entry: Entry, width: number): Line[] {
	switch (entry.kind) {
		case "user":
			return sanitize(entry.text)
				.split("\n")
				.flatMap((row, i) =>
					wrap([seg(row, { bold: true })], width, {
						prefix: [seg(i === 0 ? "› " : "  ", { ...ACCENT, bold: true })],
					}),
				);
		case "command":
			return wrap([seg(entry.text, DIM)], width, { prefix: [seg("› ", ACCENT)] });
		case "output":
			return plain(entry.text, width);
		case "notice": {
			const style: Style = entry.tone === "info" ? DIM : { bold: true };
			const mark = entry.tone === "error" ? "! " : entry.tone === "warn" ? "! " : "";
			return plain(`${mark}${entry.text}`, width, style);
		}
		case "assistant":
			return assistantLines(entry, width);
		case "tool":
			return toolLine(entry, width);
		case "revision_request":
			return revisionRequestLines(entry, width);
		case "revision_result":
			return revisionResultLines(entry.result, width);
		case "ledger":
			return ledgerLines(entry.ledger, width);
	}
}

const COMPACT = new Set(["tool", "revision_request", "revision_result"]);

export function gapBefore(prev: Entry | undefined, entry: Entry): boolean {
	if (!prev) return false;
	if (COMPACT.has(entry.kind) && COMPACT.has(prev.kind)) return false;
	if (entry.kind === "output" && prev.kind === "command") return false;
	return true;
}

export function transcriptLines(
	entries: readonly Entry[],
	width: number,
	cache?: WeakMap<Entry, Line[]>,
): Line[] {
	const lines: Line[] = [];
	entries.forEach((entry, i) => {
		if (gapBefore(entries[i - 1], entry)) lines.push([]);
		let rendered = cache?.get(entry);
		if (!rendered) {
			rendered = entryLines(entry, width);
			cache?.set(entry, rendered);
		}
		lines.push(...rendered);
	});
	return lines;
}

function evidenceRow(e: Evidence, width: number): Line {
	const via = typeof e.args.via === "string" ? e.args.via : e.tool;
	const target =
		typeof e.args.command === "string" ? e.args.command : typeof e.args.path === "string" ? e.args.path : "";
	const result = outcome(e);
	const bad = !e.executed || e.is_error || (e.tool === "Bash" && e.exit_code !== 0);
	const head: Segment[] = [seg(e.ref.padEnd(4), ACCENT), seg(`${via.padEnd(6)} `, DIM)];
	const tail = seg(` ${clip(result, 18)}`, bad ? { bold: true } : DIM);
	const room = Math.max(4, width - lineWidth(head) - lineWidth([tail]));
	const body = seg(clip(sanitize(target).replace(/\n/g, " "), room));
	return truncateLine([...head, body, ...padLine([], room - lineWidth([body])), tail], width);
}

const CLAIM_GLYPH: Record<ClaimItem["claim"]["verdict"], Segment> = {
	verified: seg("✓", DIM),
	contradicted: seg("✗", { ...BAD, bold: true }),
	unsupported: seg("✗", { ...BAD, bold: true }),
	unverifiable: seg("?", DIM),
};

function claimRow(item: ClaimItem, width: number): Line {
	const c = item.claim;
	const where = `${item.turn > 0 ? `t${item.turn}` : "--"}${c.ref ? ` ${c.ref}` : ""}`.padEnd(7);
	const glyph = item.outcome === "corrected" ? seg("↻", ACCENT) : CLAIM_GLYPH[c.verdict];
	const row: Segment[] = [glyph, seg(` ${where} `, DIM)];
	const text = seg(sanitize(c.text).replace(/\n/g, " "), isFalse(c) && !item.outcome ? {} : DIM);
	row.push(text);
	if (item.outcome === "corrected") row.push(seg(" → corrected", ACCENT));
	if (item.outcome === "still_false") row.push(seg(" → still false", BAD));
	return truncateLine(row, width);
}

function section<T>(
	title: Line,
	items: readonly T[],
	render: (item: T) => Line,
	rows: number,
	empty: string,
): Line[] {
	if (rows <= 0) return [];
	const lines: Line[] = [title];
	if (items.length === 0) return rows > 1 ? [...lines, [seg(empty, DIM)]] : lines;
	const room = rows - 1;
	if (items.length <= room) return [...lines, ...items.map(render)];
	const shown = items.slice(items.length - (room - 1));
	return [...lines, [seg(`… ${items.length - shown.length} earlier`, DIM)], ...shown.map(render)];
}

export function panelLines(
	state: Pick<TuiState, "evidence" | "claims">,
	width: number,
	height: number,
): Line[] {
	const t = tally(state.claims);
	const evTitle: Line = [seg("Evidence", { bold: true }), seg(` ${state.evidence.length}`, DIM)];
	const clTitle: Line = [
		seg("Claims", { bold: true }),
		seg(` ${t.verified}✓ `, DIM),
		seg(`${t.false}✗`, t.false > 0 ? { ...BAD, bold: true } : DIM),
		seg(` ${t.unverifiable}?`, DIM),
	];
	if (t.corrected > 0) clTitle.push(seg(` ${t.corrected} corrected`, ACCENT));
	const want = Math.max(2, state.evidence.length + 1);
	const half = Math.floor((height - 1) / 2);
	const claimWant = Math.max(2, state.claims.length + 1);
	const evRows = Math.min(want, Math.max(half, height - 1 - claimWant));
	const clRows = height - 1 - evRows;
	return [
		...section(evTitle, state.evidence, (e) => evidenceRow(e, width), evRows, "No tool calls recorded yet."),
		[],
		...section(clTitle, state.claims, (c) => claimRow(c, width), clRows, "No claims checked yet."),
	].slice(0, height);
}

export interface StatusInfo {
	provider: string;
	model: string;
	session: string;
	validate: string;
	evidence: number;
	claims: readonly ClaimItem[];
	activity?: string;
	scrolled?: number;
}

export function statusLine(info: StatusInfo, width: number): Line {
	const t = tally(info.claims);
	const sep = seg(" │ ", DIM);
	const left: Segment[] = [];
	if (info.activity) left.push(seg(info.activity, { ...ACCENT, bold: true }), sep);
	if (info.scrolled) left.push(seg(`${info.scrolled} lines below, Esc jumps back`, { bold: true }), sep);
	left.push(
		seg(`${info.provider}/${info.model}`, ACCENT),
		sep,
		seg(info.session, DIM),
		sep,
		seg(`validate ${info.validate}`, DIM),
		sep,
		seg(`${info.evidence} evidence`, DIM),
		sep,
		seg("claims ", DIM),
		seg(`${t.verified}✓ `, DIM),
		seg(`${t.false}✗`, t.false > 0 ? { ...BAD, bold: true } : DIM),
		seg(` ${t.unverifiable}?`, DIM),
	);
	if (t.corrected > 0) left.push(seg(` ${t.corrected} corrected`, ACCENT));
	return truncateLine([seg(" "), ...left], width);
}

export function hintLines(commands: readonly SlashCommand[], selected: number, width: number): Line[] {
	const nameWidth = Math.max(...commands.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`.length), 0);
	return commands.map((c, i) => {
		const usage = `/${c.name}${c.usage ? ` ${c.usage}` : ""}`.padEnd(nameWidth);
		const on = i === selected;
		return truncateLine(
			[
				seg(on ? "› " : "  ", ACCENT),
				seg(usage, on ? { ...ACCENT, bold: true } : {}),
				seg(`  ${c.description}`, DIM),
			],
			width,
		);
	});
}

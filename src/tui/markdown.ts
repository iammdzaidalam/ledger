import { type Line, type Segment, type Style, sanitize, seg, wrap } from "./text.js";

const OPEN = "";
const CLOSE = "";
const END = "";
const MARKER = /[]\d+/g;
const LEADING_MARKERS = /^((?:[]\d+)*)([\s\S]*)$/;

export function markStart(index: number): string {
	return `${OPEN}${index}${END}`;
}

export function markEnd(index: number): string {
	return `${CLOSE}${index}${END}`;
}

export function stripMarkers(text: string): string {
	return text.replace(MARKER, "");
}

export interface MarkHooks {
	flagStyle(index: number): Style | undefined;
	mark(index: number): Segment[];
}

export interface Row {
	prefix: Segment[];
	body: Segment[];
	hard?: boolean;
	rule?: boolean;
	blank?: boolean;
}

interface InlineState {
	flag: number | null;
	hooks?: MarkHooks;
}

function combine(...styles: (Style | undefined | false)[]): Style | undefined {
	const out: Style = {};
	for (const s of styles) if (s) Object.assign(out, s);
	return Object.keys(out).length > 0 ? out : undefined;
}

function readMarker(src: string, i: number): { open: boolean; index: number; next: number } | null {
	const c = src[i];
	if (c !== OPEN && c !== CLOSE) return null;
	const stop = src.indexOf(END, i + 1);
	if (stop === -1) return null;
	const index = Number(src.slice(i + 1, stop));
	if (!Number.isInteger(index)) return null;
	return { open: c === OPEN, index, next: stop + 1 };
}

function hasItalicCloser(src: string, c: string, from: number): boolean {
	for (let j = from + 1; j < src.length; j++) {
		if (src[j] !== c) continue;
		if (src[j + 1] === c || src[j - 1] === c) continue;
		if (/\S/.test(src[j - 1] ?? " ") && (c === "*" || !/\w/.test(src[j + 1] ?? " "))) return true;
	}
	return false;
}

export function inline(src: string, state: InlineState = { flag: null }, base?: Style): Segment[] {
	const out: Segment[] = [];
	let bold = false;
	let italic = false;
	let buf = "";
	const style = (extra?: Style) =>
		combine(
			base,
			bold && { bold: true },
			italic && { italic: true },
			state.flag !== null && state.hooks?.flagStyle(state.flag),
			extra,
		);
	const flush = () => {
		if (buf) out.push(seg(buf, style()));
		buf = "";
	};
	const marker = (m: { open: boolean; index: number }) => {
		flush();
		if (m.open) {
			state.flag = m.index;
			return;
		}
		state.flag = null;
		if (state.hooks) out.push(...state.hooks.mark(m.index));
	};

	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;
		const m = readMarker(src, i);
		if (m) {
			marker(m);
			i = m.next;
			continue;
		}
		if (c === "`") {
			const close = src.indexOf("`", i + 1);
			if (close > i + 1) {
				flush();
				const code = src.slice(i + 1, close);
				let last = 0;
				for (const found of code.matchAll(MARKER)) {
					const at = found.index ?? 0;
					if (at > last) out.push(seg(code.slice(last, at), style({ tone: "accent" })));
					const parsed = readMarker(found[0], 0);
					if (parsed) marker(parsed);
					last = at + found[0].length;
				}
				if (last < code.length) out.push(seg(code.slice(last), style({ tone: "accent" })));
				i = close + 1;
				continue;
			}
		}
		const pair = src.slice(i, i + 2);
		if (pair === "**" || pair === "__") {
			if (bold || src.indexOf(pair, i + 2) > i + 2) {
				flush();
				bold = !bold;
				i += 2;
				continue;
			}
		}
		if (c === "*" || c === "_") {
			const prev = src[i - 1] ?? " ";
			const next = src[i + 1] ?? " ";
			const opens =
				!italic && /\S/.test(next) && (c === "*" || !/\w/.test(prev)) && hasItalicCloser(src, c, i);
			const closes = italic && /\S/.test(prev) && (c === "*" || !/\w/.test(next));
			if (opens || closes) {
				flush();
				italic = !italic;
				i++;
				continue;
			}
		}
		if (c === "[") {
			const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
			if (link) {
				flush();
				const label = link[1] ?? "";
				const url = link[2] ?? "";
				out.push(seg(label, style({ underline: true })));
				if (url !== label) out.push(seg(` (${url})`, style({ dim: true })));
				i += link[0].length;
				continue;
			}
		}
		buf += c;
		i++;
	}
	flush();
	return out;
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

const GUTTER: Style = { dim: true };

export function markdownRows(text: string, hooks?: MarkHooks): Row[] {
	const rows: Row[] = [];
	const state: InlineState = { flag: null, hooks };
	let fence: string | null = null;
	const blank = () => {
		const last = rows.at(-1);
		if (last && !last.blank) rows.push({ prefix: [], body: [], blank: true });
	};

	for (const raw of sanitize(text).split("\n")) {
		const parts = LEADING_MARKERS.exec(raw);
		const lead = parts?.[1] ?? "";
		const rest = parts?.[2] ?? raw;

		if (fence !== null) {
			const close = FENCE.exec(rest);
			if (close?.[1]?.startsWith(fence) && !close[2]) {
				fence = null;
				continue;
			}
			rows.push({ prefix: [seg("│ ", GUTTER)], body: [seg(stripMarkers(raw))], hard: true });
			continue;
		}
		const open = FENCE.exec(rest);
		if (open) {
			fence = (open[1] ?? "```").slice(0, 3);
			if (open[2]) rows.push({ prefix: [seg("│ ", GUTTER)], body: [seg(open[2], { dim: true })] });
			continue;
		}
		if (rest.trim() === "" && lead === "") {
			blank();
			continue;
		}
		const heading = HEADING.exec(rest);
		if (heading) {
			const level = heading[1]?.length ?? 1;
			const style: Style = level <= 2 ? { bold: true, underline: level === 1 } : { bold: true };
			rows.push({ prefix: [], body: inline(lead + (heading[2] ?? ""), state, style) });
			continue;
		}
		if (RULE.test(rest) && lead === "") {
			rows.push({ prefix: [], body: [], rule: true });
			continue;
		}
		const list = LIST.exec(rest);
		if (list) {
			const depth = Math.floor((list[1] ?? "").replace(/\t/g, "  ").length / 2);
			const marker = list[2] ?? "-";
			const bullet = /\d/.test(marker) ? marker : "•";
			rows.push({
				prefix: [seg(`${"  ".repeat(depth)}${bullet} `, { dim: !/\d/.test(marker) })],
				body: inline(lead + (list[3] ?? ""), state),
			});
			continue;
		}
		const quote = QUOTE.exec(rest);
		if (quote) {
			rows.push({
				prefix: [seg("│ ", GUTTER)],
				body: inline(lead + (quote[1] ?? ""), state, { italic: true }),
			});
			continue;
		}
		rows.push({ prefix: [], body: inline(lead + rest, state) });
	}
	while (rows.at(-1)?.blank) rows.pop();
	return rows;
}

export function rowsToLines(rows: Row[], width: number, indent = 0): Line[] {
	const pad = indent > 0 ? [seg(" ".repeat(indent))] : [];
	const inner = Math.max(4, width - indent);
	const lines: Line[] = [];
	for (const row of rows) {
		if (row.blank) {
			lines.push([]);
			continue;
		}
		if (row.rule) {
			lines.push([...pad, seg("─".repeat(Math.min(inner, 40)), { dim: true })]);
			continue;
		}
		const wrapped = wrap(row.body, inner, { prefix: row.prefix, hard: row.hard });
		for (const line of wrapped) lines.push(pad.length > 0 ? [...pad, ...line] : line);
	}
	return lines;
}

export function renderMarkdown(text: string, width: number, hooks?: MarkHooks, indent = 0): Line[] {
	return rowsToLines(markdownRows(text, hooks), width, indent);
}

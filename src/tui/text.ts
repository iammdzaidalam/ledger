export type Tone = "accent" | "bad";

export interface Style {
	tone?: Tone;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
	inverse?: boolean;
}

export interface Segment {
	text: string;
	style?: Style;
}

export type Line = Segment[];

export function seg(text: string, style?: Style): Segment {
	return style ? { text, style } : { text };
}

function isZeroWidth(cp: number): boolean {
	return (
		cp < 0x20 ||
		(cp >= 0x7f && cp < 0xa0) ||
		(cp >= 0x300 && cp <= 0x36f) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		cp === 0xfeff
	);
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

export function charWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (isZeroWidth(cp)) return 0;
	return isWide(cp) ? 2 : 1;
}

export function textWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += charWidth(ch);
	return width;
}

export function lineWidth(line: Line): number {
	return line.reduce((sum, s) => sum + textWidth(s.text), 0);
}

const ESC = 27;
const BEL = 7;

function skipEscape(text: string, i: number): number {
	const kind = text[i + 1];
	if (kind === "[") {
		let j = i + 2;
		while (j < text.length) {
			const code = text.charCodeAt(j);
			j++;
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return j;
	}
	if (kind === "]") {
		let j = i + 2;
		while (j < text.length) {
			const code = text.charCodeAt(j);
			if (code === BEL) return j + 1;
			if (code === ESC && text[j + 1] === "\\") return j + 2;
			j++;
		}
		return j;
	}
	return Math.min(text.length, i + 2);
}

export function sanitize(text: string): string {
	const source = text.replace(/\r\n?/g, "\n");
	let out = "";
	let i = 0;
	while (i < source.length) {
		const code = source.charCodeAt(i);
		if (code === ESC) {
			i = skipEscape(source, i);
			continue;
		}
		const ch = source[i] as string;
		if (ch === "\t") out += "    ";
		else if (ch === "\n" || !(code < 0x20 || code === 0x7f)) out += ch;
		i++;
	}
	return out;
}

export function clip(text: string, max: number): string {
	if (max <= 0) return "";
	if (textWidth(text) <= max) return text;
	let out = "";
	let width = 0;
	for (const ch of text) {
		const w = charWidth(ch);
		if (width + w > max - 1) break;
		out += ch;
		width += w;
	}
	return `${out}…`;
}

export function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

function sameStyle(a?: Style, b?: Style): boolean {
	const x = a ?? {};
	const y = b ?? {};
	return (
		x.tone === y.tone &&
		Boolean(x.bold) === Boolean(y.bold) &&
		Boolean(x.italic) === Boolean(y.italic) &&
		Boolean(x.underline) === Boolean(y.underline) &&
		Boolean(x.dim) === Boolean(y.dim) &&
		Boolean(x.inverse) === Boolean(y.inverse)
	);
}

export function merge(line: Line): Line {
	const out: Line = [];
	for (const s of line) {
		if (s.text === "") continue;
		const last = out.at(-1);
		if (last && sameStyle(last.style, s.style)) last.text += s.text;
		else out.push({ ...s });
	}
	return out;
}

export function truncateLine(line: Line, width: number): Line {
	if (lineWidth(line) <= width) return line;
	const out: Line = [];
	let used = 0;
	for (const s of line) {
		const room = width - used;
		if (room <= 0) break;
		const w = textWidth(s.text);
		if (w < room) {
			out.push(s);
			used += w;
			continue;
		}
		out.push({ ...s, text: clip(s.text, room) });
		break;
	}
	return out;
}

export function padLine(line: Line, width: number): Line {
	const gap = width - lineWidth(line);
	return gap > 0 ? [...line, seg(" ".repeat(gap))] : line;
}

function splitChars(text: string, room: number): [string, string] {
	let head = "";
	let width = 0;
	const chars = [...text];
	let i = 0;
	for (; i < chars.length; i++) {
		const ch = chars[i] as string;
		const w = charWidth(ch);
		if (width + w > room && head !== "") break;
		head += ch;
		width += w;
	}
	return [head, chars.slice(i).join("")];
}

function trimEnd(line: Line): void {
	while (line.length > 0) {
		const last = line[line.length - 1] as Segment;
		const trimmed = last.text.replace(/\s+$/, "");
		if (trimmed) {
			line[line.length - 1] = { ...last, text: trimmed };
			return;
		}
		line.pop();
	}
}

export interface WrapOptions {
	prefix?: Segment[];
	indent?: number;
	hard?: boolean;
}

interface Unit {
	space: boolean;
	pieces: Segment[];
	width: number;
}

function units(body: Segment[], hard: boolean): Unit[] {
	const out: Unit[] = [];
	for (const s of body) {
		const tokens = hard ? [s.text] : (s.text.match(/\s+|\S+/g) ?? []);
		for (const token of tokens) {
			const space = !hard && /^\s+$/.test(token);
			const piece = { ...s, text: token };
			const last = out.at(-1);
			if (last && !space && !last.space && !hard) {
				last.pieces.push(piece);
				last.width += textWidth(token);
			} else {
				out.push({ space, pieces: [piece], width: textWidth(token) });
			}
		}
	}
	return out;
}

export function wrap(body: Segment[], width: number, options: WrapOptions = {}): Line[] {
	const prefix = options.prefix ?? [];
	const indent = options.indent ?? lineWidth(prefix);
	const lines: Line[] = [];
	let current: Line = [...prefix];
	let used = lineWidth(prefix);
	let fresh = true;
	const start = () => {
		if (!options.hard) trimEnd(current);
		lines.push(merge(current));
		current = indent > 0 ? [seg(" ".repeat(indent))] : [];
		used = indent;
		fresh = true;
	};
	const put = (piece: Segment) => {
		current.push(piece);
		used += textWidth(piece.text);
		fresh = false;
	};
	const split = (piece: Segment) => {
		let rest = piece.text;
		while (rest.length > 0) {
			if (used >= width && !fresh) start();
			const [head, tail] = splitChars(rest, Math.max(1, width - used));
			put({ ...piece, text: head });
			rest = tail;
		}
	};

	for (const unit of units(body, options.hard === true)) {
		if (unit.space) {
			if (fresh && lines.length > 0) continue;
			if (unit.width <= width - used) put(unit.pieces[0] as Segment);
			else start();
			continue;
		}
		if (unit.width <= width - used) {
			for (const piece of unit.pieces) put(piece);
			continue;
		}
		if (!fresh && !options.hard && unit.width <= width - indent) {
			start();
			for (const piece of unit.pieces) put(piece);
			continue;
		}
		for (const piece of unit.pieces) split(piece);
	}
	lines.push(merge(current));
	return lines;
}

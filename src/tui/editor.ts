import type { Key } from "ink";
import { charWidth, type Line, seg } from "./text.js";

export interface Editor {
	text: string;
	cursor: number;
}

export const EMPTY_EDITOR: Editor = { text: "", cursor: 0 };

export function setText(text: string): Editor {
	return { text, cursor: text.length };
}

export function insertText(e: Editor, s: string): Editor {
	const clean = s.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
	return {
		text: e.text.slice(0, e.cursor) + clean + e.text.slice(e.cursor),
		cursor: e.cursor + clean.length,
	};
}

function prevIndex(text: string, i: number): number {
	if (i <= 0) return 0;
	const code = text.charCodeAt(i - 1);
	return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

function nextIndex(text: string, i: number): number {
	if (i >= text.length) return text.length;
	const code = text.charCodeAt(i);
	return code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1;
}

export function deleteBack(e: Editor): Editor {
	if (e.cursor === 0) return e;
	const at = prevIndex(e.text, e.cursor);
	return { text: e.text.slice(0, at) + e.text.slice(e.cursor), cursor: at };
}

export function deleteForward(e: Editor): Editor {
	if (e.cursor >= e.text.length) return e;
	return { text: e.text.slice(0, e.cursor) + e.text.slice(nextIndex(e.text, e.cursor)), cursor: e.cursor };
}

export function moveLeft(e: Editor): Editor {
	return { ...e, cursor: prevIndex(e.text, e.cursor) };
}

export function moveRight(e: Editor): Editor {
	return { ...e, cursor: nextIndex(e.text, e.cursor) };
}

function lineStart(text: string, i: number): number {
	return text.lastIndexOf("\n", i - 1) + 1;
}

function lineEnd(text: string, i: number): number {
	const n = text.indexOf("\n", i);
	return n === -1 ? text.length : n;
}

export function home(e: Editor): Editor {
	return { ...e, cursor: lineStart(e.text, e.cursor) };
}

export function end(e: Editor): Editor {
	return { ...e, cursor: lineEnd(e.text, e.cursor) };
}

export function deleteToLineStart(e: Editor): Editor {
	const start = lineStart(e.text, e.cursor);
	if (start === e.cursor && start > 0) return deleteBack(e);
	return { text: e.text.slice(0, start) + e.text.slice(e.cursor), cursor: start };
}

export function deleteWordBack(e: Editor): Editor {
	let i = e.cursor;
	while (i > 0 && /\s/.test(e.text[i - 1] ?? "")) i--;
	while (i > 0 && !/\s/.test(e.text[i - 1] ?? "")) i--;
	return { text: e.text.slice(0, i) + e.text.slice(e.cursor), cursor: i };
}

export function moveVertical(e: Editor, dir: -1 | 1): Editor | null {
	const start = lineStart(e.text, e.cursor);
	const column = e.cursor - start;
	if (dir === -1) {
		if (start === 0) return null;
		const prevStart = lineStart(e.text, start - 1);
		return { ...e, cursor: Math.min(prevStart + column, start - 1) };
	}
	const stop = lineEnd(e.text, e.cursor);
	if (stop >= e.text.length) return null;
	const nextStart = stop + 1;
	return { ...e, cursor: Math.min(nextStart + column, lineEnd(e.text, nextStart)) };
}

export type EditResult = Editor | "submit" | null;

export function editKey(e: Editor, input: string, key: Key): EditResult {
	if (key.return && key.meta) return insertText(e, "\n");
	if (key.return) {
		if (e.cursor > 0 && e.text[e.cursor - 1] === "\\") return insertText(deleteBack(e), "\n");
		return "submit";
	}
	if (input === "\n" && !key.ctrl && !key.meta) return insertText(e, "\n");
	if (key.backspace || (key.ctrl && input === "h")) return key.meta ? deleteWordBack(e) : deleteBack(e);
	if (key.delete) return deleteForward(e);
	if (key.leftArrow) return moveLeft(e);
	if (key.rightArrow) return moveRight(e);
	if (key.home) return home(e);
	if (key.end) return end(e);
	if (key.ctrl) {
		if (input === "a") return home(e);
		if (input === "e") return end(e);
		if (input === "u") return deleteToLineStart(e);
		if (input === "w") return deleteWordBack(e);
		if (input === "k")
			return { text: e.text.slice(0, e.cursor) + e.text.slice(lineEnd(e.text, e.cursor)), cursor: e.cursor };
		return null;
	}
	if (key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown)
		return null;
	if (input) return insertText(e, input);
	return null;
}

export function editorLines(
	e: Editor,
	width: number,
	showCursor: boolean,
): { lines: Line[]; cursorLine: number } {
	const lines: Line[] = [];
	let cursorLine = 0;
	let offset = 0;
	const room = Math.max(1, width);
	for (const row of e.text.split("\n")) {
		let current = "";
		let used = 0;
		let start = offset;
		const chars = [...row];
		const flush = (end: number) => {
			const hasCursor = showCursor && e.cursor >= start && e.cursor <= end;
			if (hasCursor) {
				cursorLine = lines.length;
				const at = e.cursor - start;
				const before = current.slice(0, at);
				const rest = current.slice(at);
				const under = rest ? String.fromCodePoint(rest.codePointAt(0) ?? 32) : " ";
				lines.push([seg(before), seg(under, { inverse: true }), seg(rest.slice(under.length))]);
			} else {
				lines.push([seg(current)]);
			}
		};
		for (const ch of chars) {
			const w = charWidth(ch);
			if (used + w > room - 1 && current) {
				const end = start + current.length;
				const keep = showCursor && e.cursor === end ? end - 1 : end;
				flush(keep);
				start = end;
				current = "";
				used = 0;
			}
			current += ch;
			used += w;
		}
		flush(start + current.length);
		offset += row.length + 1;
	}
	return { lines, cursorLine };
}

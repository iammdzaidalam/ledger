import type { ClaimResult } from "../grounding/types.js";
import type { RevisionOutcome } from "../grounding/validation.js";
import { type MarkHooks, markEnd, markStart } from "./markdown.js";
import { type Segment, type Style, seg } from "./text.js";

export interface Placement {
	index: number;
	start: number;
	end: number;
}

export function stripClaimTags(text: string): string {
	return text.replace(/<claim\b[^>]*>/gi, "").replace(/<\/claim\s*>/gi, "");
}

export function fencedRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const fence = /^\s*(```|~~~)/gm;
	let open: number | null = null;
	for (const m of text.matchAll(fence)) {
		const at = m.index ?? 0;
		if (open === null) open = at;
		else {
			const lineEnd = text.indexOf("\n", at);
			ranges.push([open, lineEnd === -1 ? text.length : lineEnd]);
			open = null;
		}
	}
	if (open !== null) ranges.push([open, text.length]);
	return ranges;
}

function normalized(text: string): { text: string; map: number[] } {
	let out = "";
	const map: number[] = [];
	let space = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (/\s/.test(c)) {
			if (!space && out.length > 0) {
				out += " ";
				map.push(i);
			}
			space = true;
			continue;
		}
		space = false;
		out += c.toLowerCase();
		map.push(i);
	}
	return { text: out, map };
}

function overlaps(start: number, end: number, ranges: Array<[number, number]>): boolean {
	return ranges.some(([a, b]) => start < b && end > a);
}

function findFree(
	haystack: string,
	needle: string,
	blocked: Array<[number, number]>,
	toOriginal: (start: number, end: number) => [number, number],
): [number, number] | null {
	if (!needle) return null;
	let from = 0;
	while (from <= haystack.length) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return null;
		const span = toOriginal(at, at + needle.length);
		if (!overlaps(span[0], span[1], blocked)) return span;
		from = at + 1;
	}
	return null;
}

export function placeClaims(
	text: string,
	claims: readonly Pick<ClaimResult, "text">[],
): { placed: Placement[]; unplaced: number[] } {
	const blocked = fencedRanges(text);
	const placed: Placement[] = [];
	const unplaced: number[] = [];
	const norm = normalized(text);
	claims.forEach((claim, index) => {
		const taken = [...blocked, ...placed.map((p): [number, number] => [p.start, p.end])];
		const needle = stripClaimTags(claim.text).trim();
		const exact = findFree(text, needle, taken, (s, e) => [s, e]);
		const loose =
			exact ??
			findFree(norm.text, normalized(needle).text, taken, (s, e) => [
				norm.map[s] ?? 0,
				(norm.map[e - 1] ?? 0) + 1,
			]);
		if (loose) placed.push({ index, start: loose[0], end: loose[1] });
		else unplaced.push(index);
	});
	return { placed, unplaced };
}

export function annotate(
	text: string,
	claims: readonly Pick<ClaimResult, "text">[],
): { text: string; unplaced: number[] } {
	const { placed, unplaced } = placeClaims(text, claims);
	const inserts: Array<{ at: number; mark: string; order: number }> = [];
	for (const p of placed) {
		inserts.push({ at: p.start, mark: markStart(p.index), order: 0 });
		inserts.push({ at: p.end, mark: markEnd(p.index), order: 1 });
	}
	inserts.sort((a, b) => b.at - a.at || a.order - b.order);
	let out = text;
	for (const ins of inserts) out = out.slice(0, ins.at) + ins.mark + out.slice(ins.at);
	return { text: out, unplaced };
}

export function isFalse(claim: Pick<ClaimResult, "verdict">): boolean {
	return claim.verdict === "contradicted" || claim.verdict === "unsupported";
}

const TAGS: Record<ClaimResult["verdict"], string> = {
	verified: "✓",
	contradicted: "✗ CONTRADICTED",
	unsupported: "✗ UNSUPPORTED",
	unverifiable: "? UNVERIFIABLE",
};

const OUTCOME_TEXT: Record<RevisionOutcome, string> = {
	corrected: "corrected in revision",
	still_false: "still false after revision",
	new_false: "new false claim in revision",
};

export function verdictMark(claim: ClaimResult, outcome?: RevisionOutcome): Segment[] {
	const ref = claim.ref ? ` ${claim.ref}` : "";
	if (claim.verdict === "verified") {
		const tail = outcome ? [seg(` → ${OUTCOME_TEXT[outcome]}`, { tone: "accent" })] : [];
		return [seg(" "), seg(`${TAGS.verified}${ref}`, { dim: true }), ...tail];
	}
	const quiet = claim.verdict === "unverifiable";
	const body: Style = quiet ? { dim: true } : { tone: "bad" };
	const out: Segment[] = [seg(" "), seg("[", body)];
	out.push(seg(TAGS[claim.verdict], quiet ? { dim: true } : { tone: "bad", bold: true }));
	out.push(seg(`${ref}: ${claim.reason}`, body));
	if (outcome) {
		const style: Style = outcome === "corrected" ? { tone: "accent" } : { tone: "bad", bold: true };
		out.push(seg(` → ${OUTCOME_TEXT[outcome]}`, style));
	}
	out.push(seg("]", body));
	return out;
}

export function verdictHooks(
	claims: readonly ClaimResult[],
	outcomes: Readonly<Record<number, RevisionOutcome>> = {},
): MarkHooks {
	return {
		flagStyle: (i) => {
			const claim = claims[i];
			return claim && isFalse(claim) ? { underline: true } : undefined;
		},
		mark: (i) => {
			const claim = claims[i];
			return claim ? verdictMark(claim, outcomes[i]) : [];
		},
	};
}

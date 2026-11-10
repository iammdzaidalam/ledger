import type { ClaimResult } from "../lib/checker";
import { Stamp } from "./Stamp";

export function latency(us: number): string {
	if (us < 1000) return `${us} µs`;
	return `${(us / 1000).toFixed(us < 10000 ? 2 : 1)} ms`;
}

interface Segment {
	text: string;
	claim: ClaimResult | null;
}

export function segments(message: string, claims: ClaimResult[]): Segment[] {
	const spans: { start: number; end: number; claim: ClaimResult }[] = [];
	for (const claim of claims) {
		const start = message.indexOf(claim.text);
		if (start < 0) continue;
		const end = start + claim.text.length;
		if (spans.some((s) => start < s.end && end > s.start)) continue;
		spans.push({ start, end, claim });
	}
	spans.sort((a, b) => a.start - b.start);
	const out: Segment[] = [];
	let at = 0;
	for (const s of spans) {
		if (s.start > at) out.push({ text: message.slice(at, s.start), claim: null });
		out.push({ text: message.slice(s.start, s.end), claim: s.claim });
		at = s.end;
	}
	if (at < message.length) out.push({ text: message.slice(at), claim: null });
	return out;
}

export function Annotated({ message, claims, onRef, active }: { message: string; claims: ClaimResult[]; onRef?: (ref: string | null) => void; active?: string | null }) {
	const parts = segments(message, claims);
	if (message.trim() === "") return <p className="sb-empty">Nothing to check yet. Type a reply on the left.</p>;
	return (
		<p className="sb-reply">
			{parts.map((s, i) =>
				s.claim ? (
					<mark
						key={i}
						className={`sb-mark sb-mark--${s.claim.verdict}${active && s.claim.ref === active ? " is-active" : ""}`}
						onMouseEnter={() => onRef?.(s.claim?.ref ?? null)}
						onMouseLeave={() => onRef?.(null)}
					>
						{s.text}
						<Stamp verdict={s.claim.verdict} detail={s.claim.kind} size="sm" />
					</mark>
				) : (
					<span key={i}>{s.text}</span>
				),
			)}
		</p>
	);
}


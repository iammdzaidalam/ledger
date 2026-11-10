import { GroundingClient } from "../../src/grounding/client.js";
import type { Session, TurnView } from "./trace.js";

export const STRATA = ["flagged", "verified", "none"] as const;
export type Stratum = (typeof STRATA)[number];

const FLAG = new Set(["contradicted", "unsupported"]);

export interface StratifiedTurn {
	key: string;
	session: Session;
	view: TurnView;
	stratum: Stratum;
}

export async function stratify(sessions: Session[], checker?: string): Promise<StratifiedTurn[]> {
	const client = new GroundingClient(checker);
	const out: StratifiedTurn[] = [];
	try {
		for (const session of sessions) {
			for (const view of session.turns) {
				const res = await client.check({
					turn_text: view.text,
					evidence: view.evidence,
					fresh_refs: view.fresh,
				});
				const stratum: Stratum = res.claims.some((c) => FLAG.has(c.verdict))
					? "flagged"
					: res.claims.length
						? "verified"
						: "none";
				out.push({ key: `${session.meta.session}#${view.turn}`, session, view, stratum });
			}
		}
	} finally {
		client.close();
	}
	return out;
}

export function seeded(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
}

export function shuffle<T>(items: T[], next: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

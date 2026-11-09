import { readFile } from "node:fs/promises";
import type { ClaimKind } from "../../src/grounding/types.js";

export interface Label {
	session: string;
	turn: number;
	false_claims: ClaimKind[];
	tool_format_failure?: boolean;
	note?: string;
}

export async function readLabels(file: string): Promise<Label[]> {
	const raw = await readFile(file, "utf-8").catch(() => "");
	const byKey = new Map<string, Label>();
	for (const line of raw.split("\n").filter((l) => l.trim())) {
		const label = JSON.parse(line) as Label;
		byKey.set(`${label.session}#${label.turn}`, label);
	}
	return [...byKey.values()];
}

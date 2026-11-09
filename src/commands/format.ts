import { formatFlag } from "../grounding/format.js";
import type { Evidence } from "../grounding/types.js";
import type { ClaimRecord } from "../session/types.js";

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

function diffStat(diff: string | undefined): string {
	if (!diff) return "";
	const lines = diff.split("\n");
	const added = lines.filter((l) => l.startsWith("+")).length;
	const removed = lines.filter((l) => l.startsWith("-")).length;
	return added + removed > 0 ? ` (+${added} -${removed})` : "";
}

export function outcome(e: Evidence): string {
	if (!e.executed) return `not run: ${firstLine(e.raw_stderr) || "never started"}`;
	if (e.tool === "Bash" || e.tool === "Git")
		return e.exit_code === null ? "timed out" : `exit ${e.exit_code}`;
	return e.is_error ? `failed: ${firstLine(e.raw_stderr)}` : `ok${diffStat(e.diff)}`;
}

export function formatEvidence(e: Evidence): string {
	const via = typeof e.args.via === "string" ? e.args.via : e.tool;
	const target = typeof e.args.command === "string" ? `\`${e.args.command}\`` : String(e.args.path ?? "");
	const duration = e.executed ? `  ${(e.duration_ms / 1000).toFixed(1)}s` : "";
	return `${e.ref.padEnd(4)} ${via.padEnd(11)} ${target}  ${outcome(e)}${duration}`;
}

export function formatEvidenceLog(entries: Evidence[]): string {
	if (entries.length === 0) return "No evidence yet. Bash, Write, Edit and git calls are recorded here.";
	return entries.map(formatEvidence).join("\n");
}

export function formatClaimLog(records: ClaimRecord[]): string {
	const claims = records.flatMap((r) => r.claims);
	if (claims.length === 0) return "No claims checked yet.";
	const flagged = claims.filter((c) => c.verdict !== "verified").length;
	return [`${claims.length} claims checked, ${flagged} flagged.`, ...claims.map(formatFlag)].join("\n");
}

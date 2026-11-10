import type { GetSwarmResponse, Task } from "./types.js";

function strip(value: string | undefined, prefix: string): string {
	return (value ?? "").replace(prefix, "").toLowerCase();
}

export function lastDecision(task: Task): string {
	const attempts = task.attempts ?? [];
	for (let i = attempts.length - 1; i >= 0; i--) {
		const decision = attempts[i]?.decision;
		if (decision && decision !== "GATE_DECISION_UNSPECIFIED") return strip(decision, "GATE_DECISION_");
	}
	return "-";
}

export function outcome(task: Task): string {
	return strip(task.state, "TASK_STATE_") || "unknown";
}

export function allMerged(result: GetSwarmResponse): boolean {
	const tasks = result.tasks ?? [];
	return tasks.length > 0 && tasks.every((task) => task.state === "TASK_STATE_MERGED");
}

export function formatTable(result: GetSwarmResponse): string {
	const rows = [
		["task", "attempts", "gate", "outcome"],
		...(result.tasks ?? []).map((task) => [
			task.title || task.id,
			String((task.attempts ?? []).length),
			lastDecision(task),
			task.detail ? `${outcome(task)} (${task.detail})` : outcome(task),
		]),
	];
	const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
	return rows
		.map((row) =>
			row
				.map((cell, col) => cell.padEnd(widths[col] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

export function formatSummary(result: GetSwarmResponse, branch: string): string {
	const lines = [formatTable(result), "", `Integration branch: ${branch}`];
	if (allMerged(result)) lines.push(`To take the changes: git merge ${branch}`);
	return lines.join("\n");
}

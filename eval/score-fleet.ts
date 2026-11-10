import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { arg } from "./lib/trace.js";

interface TaskResult {
	scenario: string;
	state: string;
	attempts: number;
	verifyPassed: boolean | null;
}

interface RunResult {
	group: string;
	seed: number;
	gate: boolean;
	seconds: number;
	tasks: TaskResult[];
}

const file = resolve(arg("in", join("eval", "results", "fleet.jsonl")) as string);
const rows = (await readFile(file, "utf-8"))
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as RunResult);

function wilson(k: number, n: number): [number, number] {
	if (n === 0) return [Number.NaN, Number.NaN];
	const z = 1.96;
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [(c - m) / d, (c + m) / d];
}

const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(100 * x).toFixed(0)}%`);
const cell = (k: number, n: number) => {
	const [lo, hi] = wilson(k, n);
	return `${k}/${n} (${pct(k / n)}, ${pct(lo)}-${pct(hi)})`;
};

const isControl = (t: TaskResult) => t.scenario.startsWith("control");

function summarize(gate: boolean, controls: boolean) {
	const runs = rows.filter((r) => r.gate === gate);
	const tasks = runs.flatMap((r) => r.tasks).filter((t) => isControl(t) === controls);
	const merged = tasks.filter((t) => t.state === "merged");
	return {
		runs: runs.length,
		tasks: tasks.length,
		merged: merged.length,
		bad: merged.filter((t) => t.verifyPassed === false).length,
		good: merged.filter((t) => t.verifyPassed === true).length,
		blocked: tasks.filter((t) => t.state === "blocked").length,
		failed: tasks.filter((t) => ["failed", "cancelled"].includes(t.state)).length,
		conflict: tasks.filter((t) => t.state === "conflict").length,
		attempts: tasks.reduce((a, t) => a + t.attempts, 0) / Math.max(1, tasks.length),
		seconds: runs.reduce((a, r) => a + r.seconds, 0) / Math.max(1, runs.length),
	};
}

const line = (label: string, s: ReturnType<typeof summarize>) =>
	`| ${label} | ${s.runs} | ${s.tasks} | ${cell(s.good, s.tasks)} | ${cell(s.bad, s.merged)} | ${s.blocked} | ${s.failed + s.conflict} | ${s.attempts.toFixed(2)} | ${(s.seconds / 60).toFixed(1)} min |`;

const header =
	"| | Swarms | Tasks | Merged and verified | Merged but still failing (of merged) | Blocked | Failed or conflict | Attempts per task | Wall time per swarm |";

const report = [
	"# Fleet: gate on and off",
	"",
	"Each swarm gets three independent problems in one repository, one worker per problem. After the swarm, each problem's own verify command runs on the integration branch. A merged task counts as still failing when its verify command fails on the merged result.",
	"",
	"## Tasks with a real bug",
	"",
	header,
	"|---|---|---|---|---|---|---|---|---|",
	line("Gate on", summarize(true, false)),
	line("Gate off", summarize(false, false)),
	"",
	"## Control tasks (already green, nothing to fix)",
	"",
	header,
	"|---|---|---|---|---|---|---|---|---|",
	line("Gate on", summarize(true, true)),
	line("Gate off", summarize(false, true)),
	"",
	"Intervals are 95% Wilson intervals over tasks. Wall time is per swarm and covers all three tasks.",
	"",
].join("\n");

await writeFile(join("eval", "results", "fleet.md"), report);
console.log(report);

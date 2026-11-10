import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type Label, readLabels } from "./lib/labels.js";
import { STRATA, type Stratum, seeded, stratify } from "./lib/strata.js";
import { arg, list, loadSessions } from "./lib/trace.js";

interface Row {
	key: string;
	stratum: Stratum;
	flagged: boolean;
	label?: Label;
	judged?: boolean;
}

const traces = resolve(arg("traces", "eval/traces/openhands") as string);
const annotators = list("labels", "human,claude-a");
const judge = arg("judge");
const reps = Number(arg("reps", "2000"));
const design = arg("design");

function quantile(xs: number[], q: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
}

interface Estimate {
	precision: number;
	recall: number;
	positives: number;
	flagged: number;
}

function estimate(
	labeled: Map<Stratum, Row[]>,
	totals: Map<Stratum, number>,
	predicted: (r: Row) => boolean,
): Estimate {
	let tp = 0;
	let flagged = 0;
	let positives = 0;
	for (const h of STRATA) {
		const rows = labeled.get(h) ?? [];
		if (rows.length === 0) continue;
		const w = (totals.get(h) ?? 0) / rows.length;
		for (const r of rows) {
			const actual = (r.label?.false_claims.length ?? 0) > 0;
			const p = predicted(r);
			if (actual) positives += w;
			if (p) flagged += w;
			if (p && actual) tp += w;
		}
	}
	return {
		precision: flagged ? tp / flagged : Number.NaN,
		recall: positives ? tp / positives : Number.NaN,
		positives,
		flagged,
	};
}

function bootstrap(
	labeled: Map<Stratum, Row[]>,
	totals: Map<Stratum, number>,
	predicted: (r: Row) => boolean,
): { precision: [number, number]; recall: [number, number] } {
	const next = seeded(7);
	const ps: number[] = [];
	const rs: number[] = [];
	for (let i = 0; i < reps; i++) {
		const sample = new Map<Stratum, Row[]>();
		for (const h of STRATA) {
			const rows = labeled.get(h) ?? [];
			sample.set(
				h,
				rows.map(() => rows[Math.floor(next() * rows.length)] as Row),
			);
		}
		const e = estimate(sample, totals, predicted);
		if (!Number.isNaN(e.precision)) ps.push(e.precision);
		if (!Number.isNaN(e.recall)) rs.push(e.recall);
	}
	return {
		precision: [quantile(ps, 0.025), quantile(ps, 0.975)],
		recall: [quantile(rs, 0.025), quantile(rs, 0.975)],
	};
}

const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(100 * x).toFixed(0)}%`);
const range = ([lo, hi]: [number, number]) => `${pct(lo)}-${pct(hi)}`;

const sessions = await loadSessions(traces);
const current = await stratify(sessions);
const drawn = design ? await stratify(sessions, resolve(design)) : current;
const rows: Row[] = drawn.map((t, i) => ({
	key: t.key,
	stratum: t.stratum,
	flagged: current[i]?.stratum === "flagged",
}));

const name = annotators.find(() => true);
let primary: Map<string, Label> | undefined;
let primaryName = "";
for (const a of annotators) {
	const labels = await readLabels(join("eval", "labels", `${a}.jsonl`));
	const keys = new Set(rows.map((r) => r.key));
	const mine = labels.filter((l) => keys.has(`${l.session}#${l.turn}`));
	if (mine.length) {
		primary = new Map(mine.map((l) => [`${l.session}#${l.turn}`, l]));
		primaryName = a;
		break;
	}
}

const verdicts = new Map<string, boolean>();
if (judge) {
	const raw = await readFile(join("eval", "judge", `${judge}.jsonl`), "utf-8").catch(() => "");
	for (const line of raw.split("\n").filter((l) => l.trim())) {
		const v = JSON.parse(line) as { session: string; turn: number; false_claims: string[] };
		verdicts.set(`${v.session}#${v.turn}`, v.false_claims.length > 0);
	}
}

const totals = new Map<Stratum, number>(STRATA.map((h) => [h, rows.filter((r) => r.stratum === h).length]));
const out = [
	`# Ledger eval: ${basename(traces)}`,
	"",
	`- ${sessions.length} sessions, ${rows.length} assistant turns with text`,
	`- Turns by checker outcome: ${STRATA.map((h) => `${h} ${totals.get(h)}`).join(", ")}`,
	"",
];

if (!primary) {
	out.push(`No labels yet (${name ?? "none"}). Export packets with \`npm run eval:sample\`.`);
} else {
	for (const r of rows) r.label = primary.get(r.key);
	const labeled = new Map<Stratum, Row[]>(
		STRATA.map((h) => [h, rows.filter((r) => r.stratum === h && r.label)]),
	);
	const checker = (r: Row) => r.flagged;
	const e = estimate(labeled, totals, checker);
	const ci = bootstrap(labeled, totals, checker);
	out.push(
		`## Checker vs labels (${primaryName})`,
		"",
		primaryName.startsWith("claude")
			? "Labels by Claude annotators working blind from exported packets, without the checker's verdicts. No person has reviewed them yet.\n"
			: "",
		"| Stratum | Turns | Labeled | With a false claim |",
		"|---|---|---|---|",
		...STRATA.map((h) => {
			const l = labeled.get(h) ?? [];
			const bad = l.filter((r) => (r.label?.false_claims.length ?? 0) > 0).length;
			return `| ${h} | ${totals.get(h)} | ${l.length} | ${bad} |`;
		}),
		"",
		"Every flagged turn is labeled; verified turns and turns with no claim are random samples, weighted up to their stratum's size. Intervals are 95% bootstrap intervals within strata.",
		"",
		"| | Precision | Recall | Estimated false turns |",
		"|---|---|---|---|",
		`| Checker | ${pct(e.precision)} (${range(ci.precision)}) | ${pct(e.recall)} (${range(ci.recall)}) | ${e.positives.toFixed(0)} |`,
	);
	if (verdicts.size) {
		const judgedRows = new Map<Stratum, Row[]>(
			STRATA.map((h) => [h, (labeled.get(h) ?? []).filter((r) => verdicts.has(r.key))]),
		);
		const byJudge = (r: Row) => verdicts.get(r.key) === true;
		const j = estimate(judgedRows, totals, byJudge);
		const jci = bootstrap(judgedRows, totals, byJudge);
		const c = estimate(judgedRows, totals, checker);
		const cci = bootstrap(judgedRows, totals, checker);
		out.push(
			`| LLM judge (${judge}) | ${pct(j.precision)} (${range(jci.precision)}) | ${pct(j.recall)} (${range(jci.recall)}) | |`,
			`| Checker, same turns as the judge | ${pct(c.precision)} (${range(cci.precision)}) | ${pct(c.recall)} (${range(cci.recall)}) | |`,
		);
	}
	out.push("");
}

await mkdir(join("eval", "results"), { recursive: true });
const report = `${out.join("\n")}\n`;
await writeFile(join("eval", "results", `${arg("name", basename(traces))}.md`), report);
console.log(report);

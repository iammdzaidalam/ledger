import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { GroundingClient } from "../src/grounding/client.js";
import type { ClaimKind, ClaimResult } from "../src/grounding/types.js";
import { type Label, readLabels } from "./lib/labels.js";
import { arg, LABEL_KINDS, list, loadSessions, type Session, type TurnView } from "./lib/trace.js";

const FLAG = new Set(["contradicted", "unsupported"]);

interface Row {
	session: Session;
	view: TurnView;
	claims: ClaimResult[];
	predicted: Set<ClaimKind>;
	latencyMs: number;
}

interface Counts {
	tp: number;
	fp: number;
	fn: number;
	tn: number;
}

function wilson(k: number, n: number): [number, number] {
	if (n === 0) return [0, 0];
	const z = 1.96;
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [(c - m) / d, (c + m) / d];
}

function pct(k: number, n: number): string {
	if (n === 0) return "n/a";
	const [lo, hi] = wilson(k, n);
	return `${((100 * k) / n).toFixed(0)}% (${k}/${n}, ${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)})`;
}

function count(pairs: Array<{ predicted: boolean; actual: boolean }>): Counts {
	const c: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
	for (const { predicted, actual } of pairs) {
		if (predicted && actual) c.tp++;
		else if (predicted) c.fp++;
		else if (actual) c.fn++;
		else c.tn++;
	}
	return c;
}

function kappa(a: boolean[], b: boolean[]): number {
	const n = a.length;
	if (n === 0) return Number.NaN;
	const agree = a.filter((x, i) => x === b[i]).length / n;
	const pa = a.filter(Boolean).length / n;
	const pb = b.filter(Boolean).length / n;
	const chance = pa * pb + (1 - pa) * (1 - pb);
	return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

async function replay(sessions: Session[]): Promise<Row[]> {
	const client = new GroundingClient();
	const rows: Row[] = [];
	try {
		await client.check({ turn_text: "", evidence: [], fresh_refs: [] });
		for (const session of sessions) {
			for (const view of session.turns) {
				const started = performance.now();
				const res = await client.check({
					turn_text: view.text,
					evidence: view.evidence,
					fresh_refs: view.fresh,
				});
				const latencyMs = performance.now() - started;
				const predicted = new Set(res.claims.filter((c) => FLAG.has(c.verdict)).map((c) => c.kind));
				rows.push({ session, view, claims: res.claims, predicted, latencyMs });
			}
		}
	} finally {
		client.close();
	}
	return rows;
}

const key = (session: string, turn: number) => `${session}#${turn}`;

function metricsTable(
	title: string,
	rows: Row[],
	truth: Map<string, Label>,
	predict: (r: Row) => Set<ClaimKind>,
) {
	const labeled = rows.filter((r) => truth.has(key(r.session.meta.session, r.view.turn)));
	const lines = [
		`#### ${title}`,
		"",
		"| Rule | Precision | Recall | TP | FP | FN |",
		"|---|---|---|---|---|---|",
	];
	const actualOf = (r: Row) =>
		new Set(truth.get(key(r.session.meta.session, r.view.turn))?.false_claims ?? []);
	for (const kind of LABEL_KINDS) {
		const c = count(labeled.map((r) => ({ predicted: predict(r).has(kind), actual: actualOf(r).has(kind) })));
		if (c.tp + c.fp + c.fn === 0) continue;
		lines.push(
			`| ${kind} | ${pct(c.tp, c.tp + c.fp)} | ${pct(c.tp, c.tp + c.fn)} | ${c.tp} | ${c.fp} | ${c.fn} |`,
		);
	}
	const any = count(labeled.map((r) => ({ predicted: predict(r).size > 0, actual: actualOf(r).size > 0 })));
	lines.push(
		`| **any false claim (per turn)** | ${pct(any.tp, any.tp + any.fp)} | ${pct(any.tp, any.tp + any.fn)} | ${any.tp} | ${any.fp} | ${any.fn} |`,
	);
	return { text: lines.join("\n"), any, labeled: labeled.length };
}

function groupBy<T>(items: T[], f: (t: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const it of items) m.set(f(it), [...(m.get(f(it)) ?? []), it]);
	return m;
}

function quantile(xs: number[], q: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

const traces = resolve(arg("traces", "eval/traces/run1") as string);
const annotators = list("labels", "human");
const judges = list("judges", "");
const onlySplit = arg("split");
const sessions = (await loadSessions(traces)).filter((s) => !onlySplit || s.meta.split === onlySplit);
const rows = await replay(sessions);

const labelSets = new Map<string, Map<string, Label>>();
for (const a of annotators) {
	const labels = await readLabels(join("eval", "labels", `${a}.jsonl`));
	if (labels.length) labelSets.set(a, new Map(labels.map((l) => [key(l.session, l.turn), l])));
}
const primaryName = annotators.find((a) => labelSets.has(a));
const primary = primaryName ? labelSets.get(primaryName) : undefined;

const out: string[] = [`# Ledger eval: ${basename(traces)}`, ""];
const models = [...new Set(sessions.map((s) => s.meta.model))];
const turnsWithClaims = rows.filter((r) => r.claims.length > 0);
const tagged = rows.filter((r) => r.session.meta.claims_mode === "tagged" && r.claims.length > 0);
out.push(
	`- Sessions: ${sessions.length} (${models.join(", ")}), assistant turns with text: ${rows.length}, turns where the checker found any claim: ${turnsWithClaims.length}`,
	`- Checker latency per turn: p50 ${quantile(
		rows.map((r) => r.latencyMs),
		0.5,
	).toFixed(1)} ms, p95 ${quantile(
		rows.map((r) => r.latencyMs),
		0.95,
	).toFixed(1)} ms, zero LLM calls`,
	`- Tagged mode: ${tagged.filter((r) => r.claims.some((c) => c.attribution === "tag")).length}/${tagged.length} turns with claims used at least one <claim> tag`,
	`- Ollama settings: ${[...new Set(sessions.map((s) => `num_ctx ${s.meta.num_ctx}, num_predict ${s.meta.num_predict}, temperature ${s.meta.temperature}`))].join("; ")}`,
	"",
);

if (!primary) {
	out.push(
		"No labels found. Label with `npx tsx eval/label.ts --traces <dir>` and rerun.",
		"",
		"## Checker flags without labels",
		"",
	);
} else {
	const labeledRows = rows.filter((r) => primary.has(key(r.session.meta.session, r.view.turn)));
	out.push(
		`## Heuristic checker vs labels (${primaryName}, ${labeledRows.length}/${rows.length} turns labeled)`,
		"",
	);
	if (primaryName?.startsWith("claude"))
		out.push(
			"Labels by Claude annotators working blind from the exported packets (`eval:label --export`), without the checker's verdicts. No person has reviewed them yet.",
			"",
		);
	const SPLITS = [
		["fresh", "Fresh scenarios (written after the last rule change, never used for tuning)"],
		["test", "Held-out scenarios"],
		["dev", "Dev scenarios (rules were tuned here)"],
	] as const;
	for (const [split, title] of SPLITS) {
		const subset = rows.filter((r) => r.session.meta.split === split);
		if (subset.length === 0) continue;
		out.push(metricsTable(title, subset, primary, (r) => r.predicted).text, "");
	}

	out.push(
		"### Per model, held-out + dev",
		"",
		"| Model | Turns labeled | Turns with a false claim | Checker precision | Checker recall |",
		"|---|---|---|---|---|",
	);
	for (const [model, group] of groupBy(rows, (r) => r.session.meta.model)) {
		const m = metricsTable(model, group, primary, (r) => r.predicted);
		const falseTurns = m.any.tp + m.any.fn;
		out.push(
			`| ${model} | ${m.labeled} | ${pct(falseTurns, m.labeled)} | ${pct(m.any.tp, m.any.tp + m.any.fp)} | ${pct(m.any.tp, m.any.tp + m.any.fn)} |`,
		);
	}
	out.push("");

	out.push(
		"### False-claim rate by claims mode",
		"",
		"| Mode | Turns labeled | Turns with a false claim |",
		"|---|---|---|",
	);
	for (const [mode, group] of groupBy(labeledRows, (r) => r.session.meta.claims_mode)) {
		const bad = group.filter(
			(r) => (primary.get(key(r.session.meta.session, r.view.turn))?.false_claims.length ?? 0) > 0,
		).length;
		out.push(`| ${mode} | ${group.length} | ${pct(bad, group.length)} |`);
	}
	out.push("");

	const formatFailures = [...primary.values()].filter((l) => l.tool_format_failure).length;
	out.push(`Tool calls printed as plain text instead of called (labeled): ${formatFailures}`, "");

	for (const judge of judges) {
		const raw = await readFile(join("eval", "judge", `${judge}.jsonl`), "utf-8").catch(() => "");
		const verdicts = new Map<string, { false_claims: ClaimKind[]; latency_ms: number }>();
		for (const line of raw.split("\n").filter((l) => l.trim())) {
			const v = JSON.parse(line);
			verdicts.set(key(v.session, v.turn), v);
		}
		if (!verdicts.size) continue;
		const predict = (r: Row) =>
			new Set(verdicts.get(key(r.session.meta.session, r.view.turn))?.false_claims ?? []);
		const judged = rows.filter((r) => verdicts.has(key(r.session.meta.session, r.view.turn)));
		const lat = [...verdicts.values()].map((v) => v.latency_ms);
		out.push(
			`## LLM judge: ${judge}`,
			"",
			`${verdicts.size} turns judged, ${verdicts.size} extra LLM calls, p50 ${quantile(lat, 0.5).toFixed(0)} ms, p95 ${quantile(lat, 0.95).toFixed(0)} ms per call`,
			"",
		);
		const unseen = judged.filter((r) => r.session.meta.split !== "dev");
		out.push(metricsTable("Judge on held-out scenarios", unseen, primary, predict).text, "");
		out.push(metricsTable("Heuristics on the same turns", unseen, primary, (r) => r.predicted).text, "");
	}

	if (labelSets.size > 1) {
		const [a, b] = [...labelSets.entries()];
		if (a && b) {
			const shared = [...a[1].keys()].filter((k) => b[1].has(k));
			const x = shared.map((k) => (a[1].get(k)?.false_claims.length ?? 0) > 0);
			const y = shared.map((k) => (b[1].get(k)?.false_claims.length ?? 0) > 0);
			const agree = x.filter((v, i) => v === y[i]).length;
			out.push(
				"## Annotator agreement",
				"",
				`${a[0]} vs ${b[0]} on ${shared.length} shared turns (any false claim): ${pct(agree, shared.length)} raw agreement, Cohen's kappa ${kappa(x, y).toFixed(2)}`,
				"",
			);
		}
	}
	out.push("## Checker flags", "");
}

for (const r of rows) {
	const flags = r.claims.filter((c) => FLAG.has(c.verdict));
	if (!flags.length) continue;
	const label = primary?.get(key(r.session.meta.session, r.view.turn));
	const mark = label ? (flags.every((f) => label.false_claims.includes(f.kind)) ? "TP" : "FP?") : "-";
	for (const f of flags)
		out.push(
			`- [${mark}] \`${r.session.meta.session}\` turn ${r.view.turn}: **${f.verdict}** ${f.kind} "${f.text.slice(0, 140)}" (${f.reason})`,
		);
}

const report = `${out.join("\n")}\n`;
await mkdir(join("eval", "results"), { recursive: true });
await writeFile(join("eval", "results", `${basename(traces)}${onlySplit ? `-${onlySplit}` : ""}.md`), report);
console.log(report);

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const runDir = join(repo, "eval", "traces", "run1");
const resultsFile = join(repo, "eval", "results", "run1.md");
const freshFile = join(repo, "eval", "results", "run2.md");
const scaleFile = join(repo, "eval", "results", "openhands.md");
const outDir = join(here, "..", "src", "data");

const REPLAYS = [
	"readonly-config__llama3.1-8b__prose__s2",
	"open-rename__llama3.1-8b__tagged__s1",
	"control-node-green__qwen2.5-7b__prose__s2",
	"node-sum-bug__qwen2.5-7b__tagged__s2",
];

const MAX_LINES = 28;

function readTrace(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function allTraceFiles() {
	const files = [];
	for (const model of readdirSync(runDir, { withFileTypes: true })) {
		if (!model.isDirectory()) continue;
		for (const name of readdirSync(join(runDir, model.name))) {
			if (name.endsWith(".jsonl")) files.push(join(runDir, model.name, name));
		}
	}
	return files.sort();
}

function clip(text) {
	const value = text ?? "";
	const lines = value.replace(/\n+$/, "").split("\n");
	if (lines.length <= MAX_LINES) return { text: lines.join("\n"), omitted: 0 };
	return { text: lines.slice(0, MAX_LINES).join("\n"), omitted: lines.length - MAX_LINES };
}

function toClaim(claim) {
	return {
		text: claim.text,
		kind: claim.kind,
		ref: claim.ref ?? null,
		attribution: claim.attribution ?? null,
		verdict: claim.verdict,
		rule: claim.rule ?? claim.kind,
		reason: claim.reason ?? "",
	};
}

function buildReplay(session, records) {
	const meta = records.find((r) => r.type === "meta");
	const steps = [{ kind: "user", text: meta.prompt }];
	const pending = [];
	for (const record of records) {
		if (record.type === "turn") {
			steps.push({
				kind: "assistant",
				turn: record.turn,
				text: record.text,
				toolCalls: record.tool_calls,
			});
		} else if (record.type === "evidence") {
			pending.push(record.entry);
		} else if (record.type === "tool") {
			let evidence = null;
			if (["Bash", "Write", "Edit"].includes(record.name) && pending.length > 0) {
				const entry = pending.shift();
				evidence = {
					ref: entry.ref,
					exitCode: entry.exit_code,
					executed: entry.executed,
					isError: entry.is_error,
					durationMs: entry.duration_ms ?? null,
					diff: entry.diff ? clip(entry.diff).text : "",
				};
			}
			const output = clip(record.output);
			steps.push({
				kind: "tool",
				turn: record.turn,
				name: record.name,
				input: record.input,
				output: output.text,
				omitted: output.omitted,
				isError: record.is_error,
				evidence,
			});
		} else if (record.type === "check") {
			steps.push({ kind: "check", turn: record.turn, claims: record.claims.map(toClaim) });
		} else if (record.type === "verify") {
			const output = clip(record.output);
			steps.push({
				kind: "verify",
				command: record.command,
				exitCode: record.exit_code,
				output: output.text,
				omitted: output.omitted,
			});
		}
	}
	const end = records.find((r) => r.type === "end");
	return {
		session,
		scenario: meta.scenario,
		split: meta.split,
		category: meta.category,
		model: meta.model,
		claimsMode: meta.claims_mode,
		seed: meta.seed,
		temperature: meta.temperature,
		numCtx: meta.num_ctx,
		startedAt: meta.started_at,
		turns: end ? end.turns : null,
		source: `eval/traces/run1/${meta.model.replace(":", "-")}/${session}.jsonl`,
		steps,
	};
}

function parseResults() {
	const text = readFileSync(resultsFile, "utf8");
	const latency = text.match(/p50 ([\d.]+) ms, p95 ([\d.]+) ms/);
	const tagged = text.match(/Tagged mode: (\d+)\/(\d+)/);
	const settings = text.match(/num_ctx (\d+), num_predict (\d+), temperature ([\d.]+)/);
	const claimTurns = text.match(/turns where the checker found any claim: (\d+)/);
	if (!latency || !tagged || !settings || !claimTurns) throw new Error(`could not parse ${resultsFile}`);
	const fresh = readFileSync(freshFile, "utf8");
	const anyRow = (heading) => {
		const at = fresh.indexOf(heading);
		const row = at < 0 ? null : fresh.slice(at).match(/\*\*any false claim \(per turn\)\*\* \| [\d.]+% \((\d+)\/(\d+)[^|]*\| [\d.n/a]+%? ?\(?(\d+)?\/?(\d+)?/);
		return row ? { tp: Number(row[1]), flagged: Number(row[2]), positives: Number(row[4]) } : null;
	};
	const heldOut = anyRow("#### Fresh scenarios");
	const judge = anyRow("#### Judge on held-out scenarios");
	if (!heldOut || !judge) throw new Error(`no precision or recall in ${freshFile}`);
	const judgeLatency = fresh.match(/extra LLM calls, p50 (\d+) ms/);
	const flagLines = text.split("\n").filter((l) => /^- \[[^\]]*\] `/.test(l));
	const flagTurns = new Set(flagLines.map((l) => l.match(/`([^`]+)` turn (\d+)/).slice(1).join("#")));
	const scale = readFileSync(scaleFile, "utf8");
	const row = (name) => scale.match(new RegExp(`\\| ${name}[^|]*\\| (\\d+)% \\(([\\d]+)%-(\\d+)%\\) \\| (\\d+)% \\((\\d+)%-(\\d+)%\\)`));
	const checkerRow = row("Checker");
	const judgeRow = row("LLM judge");
	const turnsLine = scale.match(/(\d+) sessions, (\d+) assistant turns/);
	if (!checkerRow || !judgeRow || !turnsLine) throw new Error(`could not parse ${scaleFile}`);
	return {
		scale: {
			sessions: Number(turnsLine[1]),
			turns: Number(turnsLine[2]),
			precision: Number(checkerRow[1]),
			recall: Number(checkerRow[4]),
			judgePrecision: Number(judgeRow[1]),
			judgeRecall: Number(judgeRow[4]),
		},
		heldOut,
		judge: { ...judge, p50Ms: judgeLatency ? Number(judgeLatency[1]) : null },
		claimTurns: Number(claimTurns[1]),
		flaggedClaims: flagLines.length,
		flaggedTurns: flagTurns.size,
		latencyP50Ms: Number(latency[1]),
		latencyP95Ms: Number(latency[2]),
		taggedTurnsWithTag: Number(tagged[1]),
		taggedTurnsWithClaims: Number(tagged[2]),
		numCtx: Number(settings[1]),
		numPredict: Number(settings[2]),
		temperature: Number(settings[3]),
	};
}

function main() {
	const files = allTraceFiles();
	const models = new Set();
	const scenarios = new Map();
	const flags = [];
	let textTurns = 0;
	let claimTurns = 0;
	let flaggedTurns = 0;
	let verifiedClaims = 0;
	let extractedClaims = 0;
	const replays = new Map();

	for (const file of files) {
		const records = readTrace(file);
		const meta = records.find((r) => r.type === "meta");
		models.add(meta.model);
		scenarios.set(meta.scenario, { split: meta.split, category: meta.category });
		for (const record of records) {
			if (record.type === "turn" && record.text.trim() !== "") textTurns += 1;
			if (record.type !== "check") continue;
			if (record.claims.length > 0) claimTurns += 1;
			extractedClaims += record.claims.length;
			const flagged = record.claims.filter((c) => c.verdict !== "verified");
			verifiedClaims += record.claims.length - flagged.length;
			if (flagged.length > 0) flaggedTurns += 1;
			for (const claim of flagged) {
				flags.push({
					session: meta.session,
					scenario: meta.scenario,
					model: meta.model,
					claimsMode: meta.claims_mode,
					seed: meta.seed,
					turn: record.turn,
					...toClaim(claim),
				});
			}
		}
		if (REPLAYS.includes(meta.session)) replays.set(meta.session, buildReplay(meta.session, records));
	}

	const missing = REPLAYS.filter((s) => !replays.has(s));
	if (missing.length > 0) throw new Error(`missing traces: ${missing.join(", ")}`);

	const modelOrder = ["llama3.1:8b", "qwen2.5:3b", "qwen2.5:7b"];
	flags.sort((a, b) => modelOrder.indexOf(a.model) - modelOrder.indexOf(b.model));

	const scenarioList = [...scenarios.entries()]
		.map(([name, info]) => ({ name, ...info }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const evalData = {
		run: "run1",
		sessions: files.length,
		models: [...models].sort(),
		scenarios: scenarioList,
		textTurns,
		claimTurns,
		extractedClaims,
		verifiedClaims,
		flaggedClaims: flags.length,
		flaggedTurns,
		...parseResults(),
		flags,
	};

	const testFile = join(repo, "checker", "rule_tests_pass_test.go");
	const testLines = readFileSync(testFile, "utf8").split("\n");
	const startAt = testLines.findIndex((l) => l.startsWith("func TestRuleTestsPass"));
	let endAt = startAt + 1;
	let runs = 0;
	while (endAt < testLines.length && runs < 5) {
		if (testLines[endAt].trim() === "})") runs += 1;
		endAt += 1;
	}
	const code = {
		file: "checker/rule_tests_pass_test.go",
		firstLine: startAt + 1,
		lines: testLines.slice(startAt, endAt).map((l) => l.replace(/\t/g, "    ")),
	};

	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "code.json"), `${JSON.stringify(code, null, "\t")}\n`);
	writeFileSync(join(outDir, "traces.json"), `${JSON.stringify(REPLAYS.map((s) => replays.get(s)), null, "\t")}\n`);
	writeFileSync(join(outDir, "eval.json"), `${JSON.stringify(evalData, null, "\t")}\n`);
	process.stdout.write(
		`wrote ${REPLAYS.length} replays and eval stats: ${files.length} sessions, ${textTurns} text turns, ${evalData.claimTurns} with claims, ${evalData.flaggedClaims} flagged claims in ${evalData.flaggedTurns} turns\n`,
	);
}

main();

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const runDir = join(repo, "eval", "traces", "run1");
const resultsFile = join(repo, "eval", "results", "run1.md");
const freshFile = join(repo, "eval", "results", "run2.md");
const scaleFile = join(repo, "eval", "results", "openhands.md");
const fleetResults = join(repo, "eval", "results", "fleet.md");
const fleetRuns = join(repo, "eval", "results", "fleet.jsonl");
const readmeFile = join(repo, "README.md");
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

function parseFleet() {
	const md = readFileSync(fleetResults, "utf8");
	const readme = readFileSync(readmeFile, "utf8").replace(/\s+/g, " ");
	const section = (heading) => {
		const at = md.indexOf(heading);
		if (at < 0) throw new Error(`no "${heading}" in ${fleetResults}`);
		return md.slice(at).split("\n## ")[0];
	};
	const arm = (text, label) => {
		const row = text
			.split("\n")
			.map((l) => l.split("|").map((c) => c.trim()))
			.find((c) => c[1] === label);
		if (!row) throw new Error(`no "${label}" row in ${fleetResults}`);
		const verified = row[4].match(/^(\d+)\/(\d+) \((\d+)%, (\d+)%-(\d+)%\)$/);
		const failing = row[5].match(/^(\d+)\/(\d+) \((\d+)%/);
		if (!verified || !failing) throw new Error(`could not parse the ${label} row in ${fleetResults}`);
		return {
			swarms: Number(row[2]),
			tasks: Number(row[3]),
			verified: { n: Number(verified[1]), pct: Number(verified[3]), lo: Number(verified[4]), hi: Number(verified[5]) },
			stillFailing: { n: Number(failing[1]), of: Number(failing[2]), pct: Number(failing[3]) },
			blocked: Number(row[6]),
			failed: Number(row[7]),
			attempts: row[8],
			wallMin: row[9].replace(" min", ""),
		};
	};
	const bugText = section("## Tasks with a real bug");
	const controlText = section("## Control tasks");
	const bug = { on: arm(bugText, "Gate on"), off: arm(bugText, "Gate off") };
	const control = { on: arm(controlText, "Gate on"), off: arm(controlText, "Gate off") };

	const runs = readFileSync(fleetRuns, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l));
	const count = (gate) =>
		runs
			.filter((r) => r.gate === gate)
			.flatMap((r) => r.tasks)
			.filter((t) => !t.scenario.startsWith("control-") && t.state === "merged" && t.verifyPassed).length;
	if (count(true) !== bug.on.verified.n || count(false) !== bug.off.verified.n) {
		throw new Error("fleet.md and fleet.jsonl disagree on merged and verified tasks");
	}
	if (runs.length !== bug.on.swarms + bug.off.swarms) throw new Error("fleet.jsonl swarm count does not match fleet.md");

	const rate = (name, clients) => {
		const row = readme.match(new RegExp(`\\| \`${name}\` \\([^)]*${clients} clients\\) \\| ([^|]+) \\| ([^|]+) \\|`));
		if (!row) throw new Error(`no ${name} throughput row for ${clients} clients in README.md`);
		return { rate: row[1].trim(), p50: row[2].trim(), clients };
	};
	const counts = readme.match(/there were (\d+) retries and (\d+) failures of that kind/);
	const model = readme.match(/with `([^`]+)` on Ollama once with the gate/);
	if (!counts || !model) throw new Error("could not parse the fleet paragraph in README.md");
	if (!/no flag ever caused a retry or a block/.test(readme)) {
		throw new Error("README.md no longer says no flag caused a retry or a block in the fleet run");
	}
	return {
		swarms: runs.length,
		tasksPerArm: bug.on.tasks + control.on.tasks,
		model: model[1],
		bug,
		control,
		retries: Number(counts[1]),
		failures: Number(counts[2]),
		check: rate("Check", 32),
		recordTurn: rate("RecordTurn", 32),
	};
}

const PRESETS = [
	{ id: "write-failed", title: "A write that failed", session: "readonly-config__llama3.1-8b__prose__s2", turn: 2 },
	{ id: "tests-never-ran", title: "Tests that never ran", session: "open-median__qwen2.5-3b__tagged__s1", turn: 1 },
	{ id: "test-failed", title: "Tests claimed, edit failed", session: "open-median__llama3.1-8b__tagged__s2", turn: 3 },
	{ id: "lint-not-clean", title: "Lint called clean", session: "go-vet-printf__llama3.1-8b__tagged__s2", turn: 2, message: "Lint is clean now." },
	{
		id: "tests-pass",
		title: "Tests that really pass",
		session: "control-node-green__qwen2.5-7b__prose__s2",
		turn: 2,
		added: "an Edit to src/slug.js before the recorded test run, so a file counts as changed",
		prepend: [
			{
				tool: "Edit",
				args: { path: "src/slug.js" },
				raw_stdout: "Edited src/slug.js",
				raw_stderr: "",
				exit_code: null,
				executed: true,
				is_error: false,
				duration_ms: 1,
				diff: '@@ -1,3 +1,3 @@\n export function slug(s) {\n-  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n+  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n }',
			},
		],
	},
	{ id: "file-written", title: "A file that was written", session: "control-usage-doc__qwen2.5-7b__tagged__s1", turn: 2 },
];

const SWARM_GROUPS = [
	{ group: "py-cli-crash+gofmt-dirty+control-go-green", seed: 1 },
	{ group: "readonly-config+go-build-typo+open-rename", seed: 1 },
	{ group: "node-sum-bug+npm-missing-script+node-nested-config", seed: 2 },
	{ group: "control-usage-doc+py-two-failures+py-service-down", seed: 3 },
];

function buildPresets(files) {
	const byName = new Map(files.map((f) => [f.split("/").pop().replace(/\.jsonl$/, ""), f]));
	return PRESETS.map((preset) => {
		const file = byName.get(preset.session);
		if (!file) throw new Error(`no trace for preset ${preset.id}`);
		const records = readTrace(file);
		const meta = records.find((r) => r.type === "meta");
		const turn = records.find((r) => r.type === "turn" && r.turn === preset.turn);
		const check = records.find((r) => r.type === "check" && r.turn === preset.turn);
		if (!turn || !check) throw new Error(`preset ${preset.id} has no turn or check`);
		const shift = (preset.prepend ?? []).length;
		const evidence = [
			...(preset.prepend ?? []).map((e, i) => ({ ref: `c${i + 1}`, seq: i + 1, ...e })),
			...records
			.filter((r) => r.type === "evidence" && r.turn < preset.turn)
			.map((r) => ({
				ref: shift ? `c${Number(r.entry.ref.slice(1)) + shift}` : r.entry.ref,
				seq: r.entry.seq + shift,
				tool: r.entry.tool,
				args: r.entry.args,
				raw_stdout: (r.entry.raw_stdout ?? "").slice(0, 8000),
				raw_stderr: (r.entry.raw_stderr ?? "").slice(0, 8000),
				exit_code: r.entry.exit_code ?? null,
				executed: r.entry.executed,
				is_error: r.entry.is_error,
				duration_ms: r.entry.duration_ms ?? 0,
				diff: (r.entry.diff ?? "").slice(0, 4000),
			})),
		];
		return {
			id: preset.id,
			title: preset.title,
			prompt: meta.prompt,
			model: meta.model,
			session: meta.session,
			source: `eval/traces/run1/${meta.model.replace(":", "-")}/${meta.session}.jsonl`,
			turn: preset.turn,
			message: preset.message ?? turn.text,
			written: Boolean(preset.message),
			added: preset.added ?? "",
			evidence,
			recorded: preset.message ? [] : check.claims.map((c) => ({ kind: c.kind, verdict: c.verdict })),
		};
	});
}

function psql(sql) {
	return execFileSync("docker", ["exec", "ledger-test-pg", "psql", "-U", "ledger", "-d", "ledger", "-At", "-c", sql], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	}).trim();
}

const tail = (text, n) => {
	const t = (text ?? "").trim();
	if (t.length <= n) return t;
	const cut = t.slice(t.length - n);
	const space = cut.search(/\s/);
	return `…${space > 0 && space < 40 ? cut.slice(space + 1) : cut}`;
};

function buildSwarms() {
	const runs = readFileSync(fleetRuns, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l));
	const wanted = [];
	for (const g of SWARM_GROUPS) {
		for (const gate of [true, false]) {
			const run = runs.find((r) => r.group === g.group && r.seed === g.seed && r.gate === gate);
			if (!run) throw new Error(`no fleet run for ${g.group} seed ${g.seed}`);
			wanted.push(run);
		}
	}
	const ids = wanted.map((r) => `'${r.swarm}'`).join(",");
	const raw = psql(`
		select json_agg(json_build_object(
			'swarm', row_to_json(s),
			'tasks', (select json_agg(row_to_json(t) order by t.idx) from tasks t where t.swarm_id = s.id),
			'attempts', (select json_agg(row_to_json(a) order by a.number) from attempts a where a.swarm_id = s.id)
		)) from swarms s where s.id in (${ids})`);
	const rows = JSON.parse(raw);
	const byId = new Map(rows.map((r) => [r.swarm.id, r]));
	const out = [];
	for (const run of wanted) {
		const row = byId.get(run.swarm);
		if (!row) throw new Error(`swarm ${run.swarm} is not in the database`);
		const s = row.swarm;
		const t0 = Date.parse(s.created_at);
		const off = (iso) => Math.max(0, Date.parse(iso) - t0);
		const taskIdx = new Map(row.tasks.map((t) => [t.id, t.idx]));
		const tasks = row.tasks.map((t, i) => {
			const scenario = run.tasks[i].scenario;
			if (!t.prompt.includes(`${scenario}/`)) throw new Error(`task order mismatch in swarm ${run.swarm}`);
			return {
				idx: t.idx,
				scenario,
				prompt: t.prompt,
				state: t.state,
				attempts: t.attempts,
				verifyPassed: run.tasks[i].verifyPassed,
				branch: t.branch,
				commit: t.commit_sha.slice(0, 7),
				doneAt: off(t.updated_at),
			};
		});
		const events = [];
		const push = (at, order, type, task, attempt, message, data = {}) => events.push({ at, order, type, task, attempt, message, data });
		push(0, 0, "swarm.created", null, null, "swarm created", { goal: s.goal, gate: s.gate, maxAttempts: s.max_attempts, model: s.model });
		for (const t of tasks) push(0, 1, "task.queued", t.idx, null, "queued", {});
		const attempts = row.attempts.map((a) => ({ ...a, idx: taskIdx.get(a.task_id) }));
		for (const a of attempts) {
			const task = tasks[a.idx];
			const final = a.number === task.attempts;
			const start = off(a.started_at);
			const end = off(a.finished_at);
			push(start, 2, "task.claimed", a.idx, a.number, `attempt ${a.number} claimed`, {});
			push(end, 3, "attempt.completed", a.idx, a.number, `attempt ${a.number} finished`, {
				exitCode: a.exit_code,
				decision: a.decision,
				turns: a.turns,
				flaggedTurns: a.flagged_turns,
				reply: tail(a.summary, 240),
			});
			const gateType = { pass: "gate.pass", retry: "gate.retry", block: "gate.block", fail: "gate.fail" }[a.decision];
			if (!gateType) throw new Error(`unknown decision ${a.decision}`);
			const next = attempts.find((n) => n.idx === a.idx && n.number === a.number + 1);
			push(end, 4, gateType, a.idx, a.number, a.reason, {
				attempt: a.number,
				maxAttempts: s.max_attempts,
				feedback: a.decision === "retry" ? (next ? next.feedback : "") : "",
				commit: a.commit_sha.slice(0, 7),
				branch: a.branch,
			});
			if (a.decision === "retry") push(end, 5, "task.queued", a.idx, a.number + 1, "retry with feedback", {});
			if (a.decision === "pass") {
				push(end, 5, "task.merging", a.idx, a.number, "merging", {});
				if (final && task.state === "conflict") push(task.doneAt, 6, "task.conflict", a.idx, a.number, "merge conflict", {});
				else if (final) push(task.doneAt, 6, "task.merged", a.idx, a.number, "merged", { commit: task.commit, branch: task.branch });
			}
		}
		push(off(s.finished_at), 7, "swarm.done", null, null, "swarm done", {});
		events.sort((x, y) => x.at - y.at || x.order - y.order);
		out.push({
			id: run.swarm,
			short: run.swarm.slice(0, 8),
			group: run.group,
			seed: run.seed,
			gate: s.gate,
			model: s.model,
			goal: s.goal,
			maxAttempts: s.max_attempts,
			seconds: Math.round(run.seconds),
			tasks,
			events,
		});
	}
	return out;
}

const SOURCES = [
	{ id: "evidence", file: "checker/protocol.go", pattern: /^type Evidence struct/ },
	{ id: "split", file: "checker/claims.go", pattern: /^func ExtractClaims/ },
	{ id: "evaluate", file: "checker/rules.go", pattern: /^func Evaluate/ },
	{ id: "attribute", file: "checker/rules.go", pattern: /^func attribute/ },
	{ id: "tests_pass", file: "checker/rule_tests_pass.go", pattern: /^func checkTestsPass/ },
	{ id: "lint_clean", file: "checker/rule_lint_clean.go", pattern: /^func checkLintClean/ },
	{ id: "file_created", file: "checker/rule_file_created.go", pattern: /^func checkFileCreated/ },
	{ id: "bug_fixed", file: "checker/rule_bug_fixed.go", pattern: /^func checkBugFixed/ },
	{ id: "command_success", file: "checker/rule_command_success.go", pattern: /^func checkCommandSuccess/ },
	{ id: "not_executed", file: "checker/rules.go", pattern: /^func checkExecuted/ },
	{ id: "decide", file: "server/internal/orch/gate.go", pattern: /^func Decide/ },
	{ id: "feedback", file: "server/internal/orch/gate.go", pattern: /^func Feedback/ },
	{ id: "create", file: "server/internal/orch/create.go", pattern: /^func \(s \*Service\) CreateSwarm/ },
	{ id: "planner", file: "src/swarm/planner.ts", pattern: /^export async function planSubtasks/ },
	{ id: "claim", file: "server/internal/orch/claim.go", pattern: /^func \(s \*Service\) ClaimAttempt/ },
	{ id: "heartbeat", file: "server/internal/orch/claim.go", pattern: /^func \(s \*Service\) Heartbeat/ },
	{ id: "record", file: "server/internal/verify/service.go", pattern: /^func \(s \*Service\) RecordTurn/ },
	{ id: "complete", file: "server/internal/orch/complete.go", pattern: /^func \(s \*Service\) CompleteAttempt/ },
	{ id: "apply", file: "server/internal/orch/complete.go", pattern: /^func \(s \*Service\) apply/ },
	{ id: "withFeedback", file: "src/swarm/worker.ts", pattern: /^export function withFeedback/ },
	{ id: "claimMerge", file: "server/internal/orch/merge.go", pattern: /^func \(s \*Service\) ClaimMerge/ },
	{ id: "finishMerge", file: "server/internal/orch/merge.go", pattern: /^func \(s \*Service\) FinishMerge/ },
	{ id: "events", file: "server/internal/events/event.go", pattern: /^const \(/ },
];

function buildSources() {
	const out = {};
	for (const src of SOURCES) {
		const lines = readFileSync(join(repo, src.file), "utf8").split("\n");
		const at = lines.findIndex((l) => src.pattern.test(l));
		if (at < 0) throw new Error(`no ${src.pattern} in ${src.file}`);
		out[src.id] = { file: src.file, line: at + 1, lines: lines.slice(at, at + 12).map((l) => l.replace(/\t/g, "    ")) };
	}
	return out;
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
	writeFileSync(join(outDir, "source.json"), `${JSON.stringify(buildSources(), null, "\t")}\n`);
	writeFileSync(join(outDir, "sandbox.json"), `${JSON.stringify(buildPresets(files), null, "\t")}\n`);
	try {
		writeFileSync(join(outDir, "swarms.json"), `${JSON.stringify(buildSwarms(), null, "\t")}\n`);
	} catch (error) {
		process.stderr.write(`kept the recorded swarms: ${error.message.split("\n")[0]}\n`);
	}
	writeFileSync(join(outDir, "fleet.json"), `${JSON.stringify(parseFleet(), null, "\t")}\n`);
	writeFileSync(join(outDir, "eval.json"), `${JSON.stringify(evalData, null, "\t")}\n`);
	process.stdout.write(
		`wrote ${REPLAYS.length} replays and eval stats: ${files.length} sessions, ${textTurns} text turns, ${evalData.claimTurns} with claims, ${evalData.flaggedClaims} flagged claims in ${evalData.flaggedTurns} turns\n`,
	);
}

main();

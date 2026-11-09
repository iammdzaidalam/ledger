import { execSync, spawnSync } from "node:child_process";
import { appendFile, chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAgent } from "../src/agent/loop.js";
import { buildSystemPrompt } from "../src/config/system-prompt.js";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import type { ClaimsMode } from "../src/grounding/types.js";
import { ollamaSettingsFromEnv } from "../src/providers/ollama.js";
import { arg, list, loadScenarios, type Scenario, type SessionMeta, type TraceLine } from "./lib/trace.js";

const root = resolve(import.meta.dirname, "..");
const out = resolve(arg("out", join(root, "eval", "traces", "run1")) as string);
const models = list("models", "qwen2.5:7b,llama3.1:8b,qwen2.5:3b");
const modes = list("modes", "prose") as ClaimsMode[];
const seeds = list("seeds", "1").map(Number);
const only = list("scenarios", "");
const temperature = Number(arg("temperature", "0.7"));
const maxTurns = Number(arg("max-turns", "10"));
const numCtx = Number(arg("num-ctx", "16384"));
const numPredict = Number(arg("num-predict", "1536"));

process.env.LEDGER_OLLAMA_NUM_CTX = String(numCtx);
process.env.LEDGER_OLLAMA_NUM_PREDICT = String(numPredict);
process.env.LEDGER_CHECKER_PATH ??= join(root, "bin", "grounding-checker");

const commit = (() => {
	try {
		const sha = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
		const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim() ? "-dirty" : "";
		return sha + dirty;
	} catch {
		return "unknown";
	}
})();

async function digests(): Promise<Record<string, string>> {
	const res = await fetch(`${ollamaSettingsFromEnv().host}/api/tags`);
	const body = (await res.json()) as { models: { name: string; digest: string }[] };
	return Object.fromEntries(body.models.map((m) => [m.name, m.digest]));
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function makeWritable(dir: string): Promise<void> {
	await chmod(dir, 0o755).catch(() => {});
	for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (e.isDirectory()) await makeWritable(join(dir, e.name));
	}
}

function clip(s: string, n = 4000): string {
	return s.length > n ? `${s.slice(0, n)}\n[clipped]` : s;
}

async function runSession(
	scenario: Scenario,
	model: string,
	mode: ClaimsMode,
	seed: number,
	digest: string | null,
) {
	const session = `${scenario.id}__${model.replace(/[:/]/g, "-")}__${mode}__s${seed}`;
	const file = join(out, model.replace(/[:/]/g, "-"), `${session}.jsonl`);
	if (await exists(file)) return "skipped";
	await mkdir(dirname(file), { recursive: true });

	const lines: TraceLine[] = [];
	const workdir = await realpath(await mkdtemp(join(tmpdir(), "ledger-eval-")));
	await cp(join(root, "eval", "scenarios", scenario.id, "files"), workdir, { recursive: true });
	for (const cmd of scenario.setup) execSync(cmd, { cwd: workdir });

	const meta: SessionMeta = {
		type: "meta",
		session,
		scenario: scenario.id,
		split: scenario.split,
		category: scenario.category,
		prompt: scenario.prompt,
		provider: "ollama",
		model,
		model_digest: digest,
		claims_mode: mode,
		seed,
		temperature,
		num_ctx: numCtx,
		num_predict: numPredict,
		max_turns: maxTurns,
		ledger_commit: commit,
		started_at: new Date().toISOString(),
	};
	lines.push(meta);

	const started = Date.now();
	const client = new GroundingClient();
	const evidence = new EvidenceLog();
	let turn = 0;
	let error: string | undefined;
	process.env.LEDGER_SEED = String(seed);
	process.env.LEDGER_WORKSPACE = workdir;
	process.chdir(workdir);
	try {
		const system = await buildSystemPrompt(undefined, mode);
		const pendingInputs = new Map<string, Record<string, unknown>>();
		for await (const event of runAgent({
			providerName: "ollama",
			model,
			system,
			messages: [{ role: "user", content: scenario.prompt }],
			maxTurns,
			temperature,
			groundingClient: client,
			evidence,
			claimsMode: mode,
		})) {
			if (event.type === "assistant_turn") {
				turn = event.turn;
				lines.push({ type: "turn", turn, text: event.text, tool_calls: event.toolCalls });
			}
			if (event.type === "grounding_check") {
				lines.push({
					type: "check",
					turn,
					claims: event.claims,
					latency_ms: event.latencyMs,
					error: event.error,
				});
			}
			if (event.type === "tool_start") pendingInputs.set(event.id, event.input);
			if (event.type === "evidence") lines.push({ type: "evidence", turn, entry: event.entry });
			if (event.type === "tool_end") {
				lines.push({
					type: "tool",
					turn,
					name: event.name,
					input: pendingInputs.get(event.id) ?? {},
					output: clip(event.result),
					is_error: event.isError,
				});
			}
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		process.chdir(root);
		client.close();
		delete process.env.LEDGER_WORKSPACE;
	}

	if (scenario.verify) {
		const v = spawnSync("/bin/sh", ["-c", scenario.verify], {
			cwd: workdir,
			timeout: 60_000,
			encoding: "utf-8",
		});
		lines.push({
			type: "verify",
			command: scenario.verify,
			exit_code: v.status,
			output: clip(`${v.stdout}${v.stderr}`, 2000),
		});
	}
	lines.push({ type: "end", turns: turn, duration_ms: Date.now() - started, error });

	await makeWritable(workdir);
	await rm(workdir, { recursive: true, force: true });
	await appendFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return error ? `error: ${error}` : `${turn} turns, ${((Date.now() - started) / 1000).toFixed(0)}s`;
}

const scenarios = (await loadScenarios()).filter((s) => only.length === 0 || only.includes(s.id));
const known = await digests();
const plan = models.flatMap((model) =>
	modes.flatMap((mode) => seeds.flatMap((seed) => scenarios.map((s) => ({ s, model, mode, seed })))),
);
console.log(`${plan.length} sessions -> ${out}`);

let n = 0;
for (const { s, model, mode, seed } of plan) {
	n++;
	const status = await runSession(s, model, mode, seed, known[model] ?? null);
	console.log(`[${n}/${plan.length}] ${model} ${mode} s${seed} ${s.id}: ${status}`);
}

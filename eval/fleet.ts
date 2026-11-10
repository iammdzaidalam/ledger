import { execFile as execFileCb, execSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { seeded, shuffle } from "./lib/strata.js";
import { arg, list, loadScenarios, type Scenario } from "./lib/trace.js";

const execFile = promisify(execFileCb);
const root = resolve(import.meta.dirname, "..");
const server = arg("server", "http://localhost:8080") as string;
const model = arg("model", "qwen2.5:7b") as string;
const provider = arg("provider", "ollama") as string;
const groupSize = Number(arg("group-size", "3"));
const seeds = list("seeds", "1").map(Number);
const maxAttempts = arg("max-attempts", "2") as string;
const only = list("scenarios", "");
const maxGroups = Number(arg("groups", "100"));
const out = resolve(arg("out", join(root, "eval", "results", "fleet.jsonl")) as string);

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
	swarm: string;
	seconds: number;
	tasks: TaskResult[];
}

async function sh(cmd: string, cwd: string): Promise<boolean> {
	try {
		await execFile("bash", ["-c", cmd], { cwd, timeout: 120000 });
		return true;
	} catch {
		return false;
	}
}

async function buildRepo(group: Scenario[]): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "ledger-fleet-"));
	execSync("git init -q -b main && git config user.email fleet@local && git config user.name fleet", {
		cwd: repo,
	});
	for (const s of group) {
		const dir = join(repo, s.id);
		await cp(join(root, "eval", "scenarios", s.id, "files"), dir, { recursive: true });
		for (const cmd of s.setup) execSync(cmd, { cwd: dir });
	}
	execSync("git add -A && git commit -q -m 'start'", { cwd: repo });
	return repo;
}

function subtaskFlags(group: Scenario[]): string[] {
	return group.flatMap((s) => ["--subtask", `Work only inside the directory ${s.id}/. ${s.prompt}`]);
}

async function runSwarm(
	repo: string,
	group: Scenario[],
	gate: boolean,
): Promise<{ stdout: string; seconds: number }> {
	const started = Date.now();
	const args = [
		join(root, "src", "index.ts"),
		"swarm",
		`Fix these ${group.length} independent problems`,
		...subtaskFlags(group),
		"--workers",
		String(group.length),
		"--server",
		server,
		"--provider",
		provider,
		"--model",
		model,
		"--max-attempts",
		maxAttempts,
		"--json",
		...(gate ? [] : ["--no-gate"]),
	];
	const { stdout } = await execFile(join(root, "node_modules", ".bin", "tsx"), args, {
		cwd: repo,
		maxBuffer: 64 * 1024 * 1024,
		timeout: 40 * 60 * 1000,
		env: { ...process.env, LEDGER_OLLAMA_NUM_CTX: "16384", LEDGER_OLLAMA_NUM_PREDICT: "1536" },
	}).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
	return { stdout, seconds: (Date.now() - started) / 1000 };
}

interface SwarmJson {
	swarm: { id: string };
	tasks: { index?: number; title: string; prompt: string; state: string; attempts?: unknown[] }[];
}

async function verifyIntegration(
	repo: string,
	swarm: string,
	group: Scenario[],
	tasks: SwarmJson["tasks"],
): Promise<TaskResult[]> {
	const branch = `ledger/${swarm}/integration`;
	const dir = await mkdtemp(join(tmpdir(), "ledger-fleet-verify-"));
	const haveBranch = await sh(`git rev-parse --verify ${branch}`, repo);
	if (haveBranch) await sh(`git worktree add --detach ${dir} ${branch}`, repo);
	const results: TaskResult[] = [];
	for (const s of group) {
		const task = tasks.find((t) => t.prompt.includes(`directory ${s.id}/`));
		const passed = haveBranch && s.verify ? await sh(s.verify, join(dir, s.id)) : null;
		results.push({
			scenario: s.id,
			state: (task?.state ?? "TASK_STATE_UNSPECIFIED").replace("TASK_STATE_", "").toLowerCase(),
			attempts: task?.attempts?.length ?? 0,
			verifyPassed: passed,
		});
	}
	if (haveBranch) await sh(`git worktree remove --force ${dir}`, repo);
	return results;
}

async function done(): Promise<Set<string>> {
	const text = await readFile(out, "utf-8").catch(() => "");
	return new Set(
		text
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const r = JSON.parse(l) as RunResult;
				return `${r.group}|${r.seed}|${r.gate}`;
			}),
	);
}

const scenarios = (await loadScenarios()).filter(
	(s) => s.verify && (only.length === 0 || only.includes(s.id)),
);
const groups: Scenario[][] = [];
const order = shuffle(scenarios, seeded(5));
for (let i = 0; i + groupSize <= order.length && groups.length < maxGroups; i += groupSize) {
	groups.push(order.slice(i, i + groupSize));
}
await mkdir(join(out, ".."), { recursive: true });
const finished = await done();

for (const seed of seeds) {
	for (const group of groups) {
		const name = group.map((s) => s.id).join("+");
		for (const gate of [true, false]) {
			if (finished.has(`${name}|${seed}|${gate}`)) continue;
			const repo = await buildRepo(group);
			process.stderr.write(`${name} seed=${seed} gate=${gate}\n`);
			const { stdout, seconds } = await runSwarm(repo, group, gate);
			const start = stdout.indexOf("{");
			if (start < 0) {
				process.stderr.write("  no JSON from the swarm run\n");
				continue;
			}
			const body = JSON.parse(stdout.slice(start)) as SwarmJson;
			const tasks = await verifyIntegration(repo, body.swarm.id, group, body.tasks);
			const result: RunResult = { group: name, seed, gate, swarm: body.swarm.id, seconds, tasks };
			await appendFile(out, `${JSON.stringify(result)}\n`);
		}
	}
}

const rows = (await readFile(out, "utf-8").catch(() => ""))
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as RunResult);
await writeFile(out.replace(/\.jsonl$/, ".raw.json"), JSON.stringify(rows, null, 2));

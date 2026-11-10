import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const behavior = JSON.parse(process.env.FAKE_BEHAVIOR ?? "{}");
const prompt = process.argv.at(-1) ?? "";

if (behavior.log) {
	const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
	const files = readdirSync(process.cwd()).filter((name) => name !== ".git");
	const record = {
		cwd: process.cwd(),
		prompt,
		head,
		files,
		args: process.argv.slice(2, -1),
		server: process.env.LEDGER_SERVER,
		runId: process.env.LEDGER_RUN_ID,
	};
	appendFileSync(behavior.log, `${JSON.stringify(record)}\n`);
}

for (const [name, content] of Object.entries(behavior.writes ?? {})) {
	const file = join(process.cwd(), name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

if (behavior.ignoreTerm) process.on("SIGTERM", () => {});

const finish = () => process.exit(behavior.exit ?? 0);
if (behavior.sleepMs) setTimeout(finish, behavior.sleepMs);
else finish();

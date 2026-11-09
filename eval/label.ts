import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ClaimKind } from "../src/grounding/types.js";
import { type Label, readLabels } from "./lib/labels.js";
import { LABEL_GUIDE, renderTurn } from "./lib/render.js";
import { arg, loadSessions, type Session, type TurnView } from "./lib/trace.js";

const KEYS: Record<string, ClaimKind> = {
	t: "tests_pass",
	f: "file_created",
	b: "bug_fixed",
	l: "lint_clean",
	c: "command_success",
};

function shuffled<T>(items: T[], seed: number): T[] {
	const out = [...items];
	let s = seed;
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) % 2147483648;
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

function queue(sessions: Session[]): Array<{ session: Session; view: TurnView }> {
	const items = sessions.flatMap((session) => session.turns.map((view) => ({ session, view })));
	return shuffled(items, 7);
}

async function exportPackets(sessions: Session[], dir: string, chunk: number) {
	await mkdir(dir, { recursive: true });
	const items = queue(sessions);
	for (let i = 0; i < items.length; i += chunk) {
		const body = items
			.slice(i, i + chunk)
			.map(
				({ session, view }) =>
					`=== ITEM session=${session.meta.session} turn=${view.turn}\n${renderTurn(session, view)}`,
			)
			.join("\n\n");
		await writeFile(
			join(dir, `packet-${String(i / chunk + 1).padStart(3, "0")}.txt`),
			`${LABEL_GUIDE}\n\n${body}\n`,
		);
	}
	console.log(`${items.length} turns in ${Math.ceil(items.length / chunk)} packets -> ${dir}`);
}

async function interactive(sessions: Session[], file: string) {
	const done = new Set((await readLabels(file)).map((l) => `${l.session}#${l.turn}`));
	const todo = queue(sessions).filter(
		({ session, view }) => !done.has(`${session.meta.session}#${view.turn}`),
	);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	console.log(
		`${LABEL_GUIDE}\n\nKeys: any of t f b l c, Enter for none, x = tool call printed as text, u = redo the previous turn, s = skip, q = quit.`,
	);
	console.log(`${todo.length} turns left, labels go to ${file}\n`);

	const lines = rl[Symbol.asyncIterator]();
	const ask = async (prompt: string) => {
		process.stdout.write(prompt);
		const next = await lines.next();
		return next.done ? "q" : String(next.value);
	};
	const labeled: number[] = [];
	try {
		let i = 0;
		while (i < todo.length) {
			const item = todo[i];
			if (!item) break;
			const { session, view } = item;
			console.log(`\n${"-".repeat(72)}\n[${i + 1}/${todo.length}]\n${renderTurn(session, view)}\n`);
			const answer = (await ask("false claims> ")).trim().toLowerCase();
			if (answer === "q") break;
			if (answer === "u") {
				const back = labeled.pop();
				if (back === undefined) console.log("Nothing to redo yet.");
				else i = back;
				continue;
			}
			if (answer === "s") {
				i++;
				continue;
			}
			const kinds = [...new Set([...answer].filter((ch) => ch in KEYS).map((ch) => KEYS[ch] as ClaimKind))];
			const label: Label = { session: session.meta.session, turn: view.turn, false_claims: kinds };
			if (answer.includes("x")) label.tool_format_failure = true;
			await appendFile(file, `${JSON.stringify(label)}\n`);
			labeled.push(i);
			i++;
		}
	} finally {
		rl.close();
	}
}

const traces = resolve(arg("traces", "eval/traces/run1") as string);
const split = arg("split");
const sessions = (await loadSessions(traces)).filter((s) => !split || s.meta.split === split);
const exportDir = arg("export");
if (exportDir) {
	await exportPackets(sessions, resolve(exportDir), Number(arg("chunk", "40")));
} else {
	const annotator = arg("annotator", "human") as string;
	const file = resolve(arg("labels", join("eval", "labels", `${annotator}.jsonl`)) as string);
	await mkdir(resolve(file, ".."), { recursive: true });
	await interactive(sessions, file);
}

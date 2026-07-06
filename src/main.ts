import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP_TEXT, parseArgs } from "./cli/args.js";
import { loadSettings } from "./config/settings.js";
import { buildSystemPrompt } from "./config/system-prompt.js";
import { runInteractive } from "./modes/interactive.js";
import { runPrint } from "./modes/print.js";
import { defaultModelFor, MODELS } from "./providers/index.js";

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8").trim();
}

export async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(HELP_TEXT);
		return;
	}

	if (args.version) {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));
		console.log(pkg.version);
		return;
	}

	const settings = await loadSettings();
	const provider = args.provider ?? settings.provider ?? "claude";
	const model = args.model ?? settings.model ?? defaultModelFor(provider);

	if (!MODELS.some((m) => m.id === model)) {
		console.error(`Unknown model: ${model}`);
		process.exit(1);
	}

	const system = await buildSystemPrompt(settings.systemPromptExtra);
	const stdinMessage = await readStdin();
	const message = args.message ?? stdinMessage;

	if (args.print || stdinMessage) {
		if (!message) {
			console.error("No message given for print mode.");
			process.exit(1);
		}
		await runPrint({ providerName: provider, model, system, message, maxTurns: settings.maxTurns });
	} else {
		await runInteractive({
			providerName: provider,
			model,
			system,
			initialMessage: message,
			maxTurns: settings.maxTurns,
		});
	}
}

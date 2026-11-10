import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP_TEXT, type ParsedArgs, parseArgs } from "./cli/args.js";
import { loadSettings } from "./config/settings.js";
import { buildSystemPrompt } from "./config/system-prompt.js";
import type { Settings } from "./config/types.js";
import { isValidationMode, type ValidationMode } from "./grounding/validation.js";
import { runInteractive } from "./modes/interactive.js";
import { runPrint } from "./modes/print.js";
import { defaultModelFor, isKnownModel, PROVIDERS } from "./providers/index.js";
import { ActiveSession } from "./session/active.js";
import {
	defaultSessionId,
	formatSessionList,
	latestSessionId,
	listSessions,
	loadSession,
	resolveSessionId,
} from "./session/store.js";
import type { SessionData } from "./session/types.js";
import { parseSwarmArgs } from "./swarm/args.js";

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8").trim();
}

async function savedSession(args: ParsedArgs): Promise<SessionData | null> {
	if (args.resume) return loadSession(await resolveSessionId(args.resume));
	if (args.continue) {
		const id = await latestSessionId();
		if (!id) throw new Error("No saved sessions to continue in .ledger/sessions.");
		return loadSession(id);
	}
	if (args.session) {
		const data = await loadSession(args.session);
		return data && (data.messageCount > 0 || data.evidence.length > 0) ? data : null;
	}
	return null;
}

function pickModel(
	args: Pick<ParsedArgs, "provider" | "model">,
	settings: Settings,
	saved: SessionData | null,
): { provider: string; model: string } {
	const provider = args.provider ?? saved?.provider ?? settings.provider ?? "claude";
	if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown provider: ${provider}`);
	const fromSaved = saved?.provider === provider ? saved.model : undefined;
	const fromSettings = !settings.provider || settings.provider === provider ? settings.model : undefined;
	const model = args.model ?? fromSaved ?? fromSettings ?? defaultModelFor(provider);
	if (!isKnownModel(provider, model)) {
		throw new Error(`Unknown model for ${provider}: ${model}. Run ledger and type /model to list them.`);
	}
	return { provider, model };
}

function pickValidation(args: ParsedArgs, settings: Settings) {
	const validate: unknown =
		args.validate ??
		(args.feedback ? "revise" : undefined) ??
		settings.validate ??
		(settings.feedback === true ? "revise" : "flag");
	if (!isValidationMode(validate)) throw new Error(`Unknown validate mode: ${validate}`);
	const maxRevisions = args.maxRevisions === undefined ? settings.maxRevisions : Number(args.maxRevisions);
	if (maxRevisions !== undefined && !(Number.isInteger(maxRevisions) && maxRevisions >= 0)) {
		throw new Error(`--max-revisions must be a whole number, got: ${args.maxRevisions ?? maxRevisions}`);
	}
	return {
		validate: validate as ValidationMode,
		maxRevisions,
		maxRevisionsPerRun: settings.maxRevisionsPerRun,
	};
}

export function shouldUseTui(
	args: Pick<ParsedArgs, "noTui">,
	settings: Pick<Settings, "tui">,
	stdinTTY = process.stdin.isTTY === true,
	stdoutTTY = process.stdout.isTTY === true,
): boolean {
	return !args.noTui && settings.tui !== false && stdinTTY && stdoutTTY;
}

async function runSwarm(argv: string[]): Promise<void> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}
	const swarmArgs = parseSwarmArgs(argv);
	const choice = pickModel(swarmArgs, await loadSettings(), null);
	const { runSwarmCommand } = await import("./swarm/run.js");
	process.exitCode = await runSwarmCommand(swarmArgs, choice);
}

export async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "swarm") return runSwarm(argv.slice(1));
	const args = parseArgs(argv);
	if (args.server) process.env.LEDGER_SERVER = args.server;

	if (args.help) {
		console.log(HELP_TEXT);
		return;
	}

	if (args.version) {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));
		console.log(pkg.version);
		return;
	}

	if (args.listSessions) {
		console.log(formatSessionList(await listSessions()));
		return;
	}

	const settings = await loadSettings();
	const claimsMode = args.claims ?? settings.claimsMode ?? "prose";
	const validation = pickValidation(args, settings);

	if (claimsMode !== "prose" && claimsMode !== "tagged") {
		throw new Error(`Unknown claims mode: ${claimsMode}`);
	}

	const saved = await savedSession(args);
	const { provider, model } = pickModel(args, settings, saved);
	const session = saved
		? ActiveSession.fromData(saved, provider, model)
		: ActiveSession.create(args.session ?? defaultSessionId(), provider, model);

	const system = await buildSystemPrompt(settings.systemPromptExtra, claimsMode);
	const stdinMessage = await readStdin();
	const message = args.message ?? stdinMessage;
	const turn = {
		system,
		maxTurns: settings.maxTurns,
		claimsMode,
		...validation,
		contextLimit: settings.contextLimit,
		autoCompact: settings.autoCompact,
	} as const;

	if (args.print || stdinMessage) {
		if (!message) throw new Error("No message given for print mode.");
		process.exitCode = await runPrint({
			session,
			turn,
			permissions: settings.permissions,
			yes: args.yes,
			message,
			canPrompt: process.stdin.isTTY === true,
		});
		return;
	}

	const interactive = {
		session,
		turn,
		permissions: settings.permissions,
		yes: args.yes,
		initialMessage: message || undefined,
		resumed: saved !== null,
	};
	if (shouldUseTui(args, settings)) {
		const { runTui } = await import("./tui/run.js");
		await runTui(interactive);
		return;
	}
	await runInteractive(interactive);
}

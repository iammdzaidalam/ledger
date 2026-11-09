import {
	compactHistory,
	describeCompaction,
	providerSummarizer,
	type Summarizer,
} from "../agent/compaction.js";
import { getApiKey } from "../agent/loop.js";
import { createProvider, defaultModelFor, findModel, modelsFor, PROVIDERS } from "../providers/index.js";
import { ActiveSession } from "../session/active.js";
import { formatSessionList, listSessions, loadSession, resolveSessionId } from "../session/store.js";
import { formatClaimLog, formatEvidenceLog } from "./format.js";
import type { CommandContext, SlashCommand } from "./registry.js";

const MANUAL_KEEP_RECENT = 2;

function keyProblem(providerName: string): string | undefined {
	try {
		getApiKey(providerName);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function defaultSummarizer(session: ActiveSession): Summarizer | undefined {
	try {
		return providerSummarizer(
			createProvider(session.providerName, getApiKey(session.providerName)),
			session.model,
		);
	} catch {
		return undefined;
	}
}

const help: SlashCommand = {
	name: "help",
	description: "List the commands",
	run(ctx) {
		const rows = ctx.commands.map((c) => {
			const usage = `/${c.name}${c.usage ? ` ${c.usage}` : ""}`;
			return `  ${usage.padEnd(22)} ${c.description}`;
		});
		ctx.print(`Commands\n${rows.join("\n")}`);
		return undefined;
	},
};

const clear: SlashCommand = {
	name: "clear",
	description: "Drop the conversation history; the evidence log is kept",
	async run(ctx) {
		await ctx.state.session.clear();
		ctx.print("History cleared. The evidence log is kept, so later claims are still checked against it.");
		return undefined;
	},
};

function listModels(ctx: CommandContext): void {
	const session = ctx.state.session;
	const rows = modelsFor(session.providerName).map((m) => {
		const mark = m.id === session.model ? "*" : " ";
		return `${mark} ${m.id.padEnd(26)} ${m.name}, ${Math.round(m.contextWindow / 1000)}K context`;
	});
	if (session.providerName === "ollama" && !rows.some((r) => r.startsWith("*"))) {
		rows.unshift(`* ${session.model}`);
	}
	const extra = session.providerName === "ollama" ? "\nAny local tag works, e.g. /model qwen2.5:7b" : "";
	ctx.print(`Models for ${session.providerName}:\n${rows.join("\n")}${extra}\nOther providers: /provider`);
}

const model: SlashCommand = {
	name: "model",
	usage: "[id]",
	description: "Show the models for this provider, or switch model",
	run(ctx) {
		if (!ctx.args) {
			listModels(ctx);
			return undefined;
		}
		const session = ctx.state.session;
		const info = findModel(ctx.args);
		if (!info && session.providerName !== "ollama") {
			ctx.print(`Unknown model "${ctx.args}" for ${session.providerName}. Run /model to list them.`);
			return undefined;
		}
		const providerName = info?.provider ?? "ollama";
		session.switchModel(providerName, info?.id ?? ctx.args);
		const problem = keyProblem(providerName);
		ctx.print(
			`Now using ${providerName}/${session.model}. History and evidence carry over.${problem ? ` ${problem}.` : ""}`,
		);
		return undefined;
	},
};

const provider: SlashCommand = {
	name: "provider",
	usage: "[name]",
	description: "Show the providers, or switch provider (uses its default model)",
	run(ctx) {
		const session = ctx.state.session;
		if (!ctx.args) {
			const rows = PROVIDERS.map((p) => {
				const mark = p === session.providerName ? "*" : " ";
				const problem = keyProblem(p);
				return `${mark} ${p.padEnd(8)} ${problem ? problem : "ready"}`;
			});
			ctx.print(`Providers:\n${rows.join("\n")}`);
			return undefined;
		}
		const name = ctx.args.toLowerCase();
		if (!(PROVIDERS as readonly string[]).includes(name)) {
			ctx.print(`Unknown provider "${ctx.args}". Choose one of: ${PROVIDERS.join(", ")}.`);
			return undefined;
		}
		session.switchModel(name, defaultModelFor(name));
		const problem = keyProblem(name);
		ctx.print(`Now using ${name}/${session.model}.${problem ? ` ${problem}.` : ""}`);
		return undefined;
	},
};

const sessions: SlashCommand = {
	name: "sessions",
	description: "List saved sessions in this directory",
	async run(ctx) {
		ctx.print(formatSessionList(await listSessions(ctx.state.cwd)));
		return undefined;
	},
};

const resume: SlashCommand = {
	name: "resume",
	usage: "<id>",
	description: "Load a saved session (an id prefix is enough)",
	async run(ctx) {
		if (!ctx.args) {
			ctx.print(`${formatSessionList(await listSessions(ctx.state.cwd), 10)}\nUsage: /resume <id>`);
			return undefined;
		}
		const id = await resolveSessionId(ctx.args, ctx.state.cwd);
		const current = ctx.state.session;
		if (id === current.id) {
			ctx.print(`Already in session ${id}.`);
			return undefined;
		}
		const data = await loadSession(id, ctx.state.cwd);
		if (!data) throw new Error(`could not read session ${id}`);
		const next = ActiveSession.fromData(
			data,
			data.provider ?? current.providerName,
			data.model ?? current.model,
		);
		ctx.state.session = next;
		const claims = data.claims.flatMap((r) => r.claims).length;
		ctx.print(
			`Resumed ${id} (${next.providerName}/${next.model}): ${data.messages.length} messages in context, ` +
				`${data.evidence.length} evidence entries, ${claims} claims checked.`,
		);
		return undefined;
	},
};

const compact: SlashCommand = {
	name: "compact",
	description: "Summarise older turns now to free up context",
	async run(ctx) {
		const session = ctx.state.session;
		const summarize = ctx.state.summarizer ? ctx.state.summarizer(session) : defaultSummarizer(session);
		const result = await compactHistory(session.history, summarize, MANUAL_KEEP_RECENT);
		if (!result) {
			ctx.print("Nothing to compact yet.");
			return undefined;
		}
		await session.applyCompaction(result);
		ctx.print(describeCompaction(result));
		return undefined;
	},
};

const evidence: SlashCommand = {
	name: "evidence",
	description: "Print the evidence log for this session",
	run(ctx) {
		ctx.print(formatEvidenceLog(ctx.state.session.evidence.all()));
		return undefined;
	},
};

const claims: SlashCommand = {
	name: "claims",
	description: "Print every claim checked in this session and its verdict",
	run(ctx) {
		ctx.print(formatClaimLog(ctx.state.session.claims));
		return undefined;
	},
};

const exit: SlashCommand = {
	name: "exit",
	aliases: ["quit"],
	description: "Quit",
	run: () => ({ exit: true }),
};

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
	help,
	clear,
	model,
	provider,
	sessions,
	resume,
	compact,
	evidence,
	claims,
	exit,
];

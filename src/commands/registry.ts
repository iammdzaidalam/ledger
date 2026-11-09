import type { Summarizer } from "../agent/compaction.js";
import type { ActiveSession } from "../session/active.js";

export interface ReplState {
	session: ActiveSession;
	summarizer?: (session: ActiveSession) => Summarizer | undefined;
	cwd?: string;
}

export interface CommandResult {
	exit?: boolean;
}

export interface CommandContext {
	args: string;
	state: ReplState;
	commands: readonly SlashCommand[];
	print(text: string): void;
}

export interface SlashCommand {
	name: string;
	aliases?: string[];
	usage?: string;
	description: string;
	run(ctx: CommandContext): Promise<CommandResult | undefined> | CommandResult | undefined;
}

export function parseCommandLine(line: string): { name: string; args: string } | null {
	const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(line.trim());
	if (!match?.[1]) return null;
	return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
	return commands.find((c) => c.name === name || c.aliases?.includes(name));
}

export async function runCommandLine(
	line: string,
	ctx: Omit<CommandContext, "args">,
): Promise<CommandResult & { handled: boolean }> {
	const parsed = parseCommandLine(line);
	if (!parsed) return { handled: false };
	const command = findCommand(ctx.commands, parsed.name);
	if (!command) {
		ctx.print(`Unknown command /${parsed.name}. Try /help.`);
		return { handled: true };
	}
	try {
		const result = await command.run({ ...ctx, args: parsed.args });
		return { handled: true, ...result };
	} catch (err) {
		ctx.print(`/${command.name} failed: ${err instanceof Error ? err.message : String(err)}`);
		return { handled: true };
	}
}

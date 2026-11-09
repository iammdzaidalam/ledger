import { createInterface } from "node:readline/promises";
import { consola } from "consola";
import { BUILTIN_COMMANDS } from "../commands/builtin.js";
import { type ReplState, runCommandLine } from "../commands/registry.js";
import { GroundingClient } from "../grounding/client.js";
import { formatLedger, formatUnverified } from "../grounding/format.js";
import { createPolicy } from "../permissions/policy.js";
import { terminalAsker } from "../permissions/prompt.js";
import type { PermissionSettings } from "../permissions/types.js";
import { readableError } from "../providers/errors.js";
import type { ActiveSession } from "../session/active.js";
import { runTurn, type TurnSettings } from "./turn.js";

export interface InteractiveOptions {
	session: ActiveSession;
	turn: Omit<TurnSettings, "permissions">;
	permissions?: PermissionSettings;
	yes: boolean;
	initialMessage?: string;
	resumed: boolean;
}

function banner(session: ActiveSession, resumed: boolean): string {
	const lines = [
		`ledger (${session.providerName}/${session.model}), session ${session.id}`,
		"/help for commands, Ctrl+C to quit.",
	];
	if (resumed) {
		lines.splice(
			1,
			0,
			`Resumed with ${session.history.length} messages in context and ${session.evidence.all().length} evidence entries.`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const groundingClient = new GroundingClient();
	const state: ReplState = { session: options.session };
	const print = (text: string) => process.stdout.write(`${text}\n`);
	const ask = terminalAsker(
		(q) => rl.question(q),
		(t) => process.stdout.write(t),
	);
	const color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
	const turn: TurnSettings = {
		...options.turn,
		permissions: createPolicy(options.permissions, options.yes, ask),
	};

	const shutdown = () => {
		groundingClient.close();
		rl.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);

	print(banner(state.session, options.resumed));

	try {
		let next = options.initialMessage;
		while (true) {
			let input: string;
			if (next !== undefined) {
				input = next;
				next = undefined;
			} else {
				try {
					input = await rl.question("> ");
				} catch {
					break;
				}
			}
			if (!input.trim()) continue;

			const command = await runCommandLine(input, { state, commands: BUILTIN_COMMANDS, print });
			if (command.handled) {
				if (command.exit) break;
				continue;
			}

			try {
				const ledger = await runTurn(state.session, input, turn, groundingClient);
				const summary = ledger ? formatLedger(ledger, color) : "";
				if (summary) process.stderr.write(`\n\n${summary}`);
				if (turn.validate === "strict" && ledger?.unverified) {
					process.stderr.write(`\n${formatUnverified(ledger)}`);
				}
			} catch (err) {
				process.stdout.write("\n");
				consola.error(readableError(err));
			}
			process.stdout.write("\n\n");
		}
	} finally {
		groundingClient.close();
		rl.close();
		process.removeListener("SIGINT", shutdown);
	}
}

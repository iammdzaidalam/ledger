import { createInterface } from "node:readline/promises";
import { consola } from "consola";
import { GroundingClient } from "../grounding/client.js";
import { formatLedger, formatUnverified } from "../grounding/format.js";
import { createPolicy, NO_TERMINAL_REASON } from "../permissions/policy.js";
import { terminalAsker } from "../permissions/prompt.js";
import type { PermissionRequest, PermissionSettings } from "../permissions/types.js";
import { readableError } from "../providers/errors.js";
import type { ActiveSession } from "../session/active.js";
import { runTurn, type TurnSettings } from "./turn.js";

export interface PrintOptions {
	session: ActiveSession;
	turn: Omit<TurnSettings, "permissions">;
	permissions?: PermissionSettings;
	yes: boolean;
	message: string;
	canPrompt: boolean;
}

export const UNVERIFIED_EXIT_CODE = 2;

export async function runPrint(options: PrintOptions): Promise<number> {
	const rl = options.canPrompt
		? createInterface({ input: process.stdin, output: process.stderr })
		: undefined;
	const ask = rl
		? terminalAsker(
				(q) => rl.question(q),
				(t) => process.stderr.write(t),
			)
		: undefined;
	let explained = false;
	const onDenied = (request: PermissionRequest, reason: string) => {
		const why = reason === NO_TERMINAL_REASON && explained ? "no terminal to ask" : reason;
		if (reason === NO_TERMINAL_REASON) explained = true;
		consola.warn(`Denied ${request.tool} (${request.summary}): ${why}`);
	};
	const permissions = createPolicy(options.permissions, options.yes, ask, onDenied);
	const groundingClient = new GroundingClient();
	const color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

	try {
		const ledger = await runTurn(
			options.session,
			options.message,
			{ ...options.turn, permissions },
			groundingClient,
		);
		process.stdout.write("\n");
		const summary = ledger ? formatLedger(ledger, color) : "";
		if (summary) process.stderr.write(`\n${summary}\n`);
		if (options.turn.validate !== "strict" || !ledger?.unverified) return 0;
		const marker = formatUnverified(ledger);
		process.stdout.write(`${marker}\n`);
		process.stderr.write(`${color ? `\x1b[1;31m${marker}\x1b[0m` : marker}\n`);
		return UNVERIFIED_EXIT_CODE;
	} catch (err) {
		process.stdout.write("\n");
		consola.error(readableError(err));
		return 1;
	} finally {
		groundingClient.close();
		rl?.close();
	}
}

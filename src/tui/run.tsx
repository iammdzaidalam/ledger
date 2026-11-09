import { consola, type LogObject } from "consola";
import { render } from "ink";
import type { ReplState } from "../commands/registry.js";
import { GroundingClient } from "../grounding/client.js";
import type { InteractiveOptions } from "../modes/interactive.js";
import type { TurnSettings } from "../modes/turn.js";
import { createPolicy } from "../permissions/policy.js";
import { App, type LogSink } from "./app.js";
import { PermissionQueue } from "./permission.js";

function logText(log: LogObject): string {
	const parts = [log.message, ...(log.args ?? [])].filter((p) => p !== undefined && p !== "");
	return parts.map((p) => (p instanceof Error ? p.message : String(p))).join(" ");
}

function captureLogs(): { sink: LogSink; restore: () => void } {
	const previous = [...consola.options.reporters];
	const buffered: string[] = [];
	let handler: ((text: string) => void) | null = null;
	consola.setReporters([
		{
			log: (log) => {
				const text = logText(log);
				if (!text) return;
				if (handler) handler(text);
				else buffered.push(text);
			},
		},
	]);
	const sink: LogSink = {
		attach(next) {
			handler = next;
			for (const text of buffered.splice(0)) next(text);
			return () => {
				if (handler === next) handler = null;
			};
		},
	};
	return { sink, restore: () => consola.setReporters(previous) };
}

export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !env.NO_COLOR;
}

export async function runTui(options: InteractiveOptions): Promise<void> {
	const groundingClient = new GroundingClient();
	const permissions = new PermissionQueue();
	const repl: ReplState = { session: options.session };
	const turn: TurnSettings = {
		...options.turn,
		permissions: createPolicy(options.permissions, options.yes, permissions.ask),
	};
	const logs = captureLogs();

	try {
		const instance = render(
			<App
				repl={repl}
				turn={turn}
				groundingClient={groundingClient}
				permissions={permissions}
				initialMessage={options.initialMessage}
				resumed={options.resumed}
				color={colorEnabled()}
				logs={logs.sink}
			/>,
			{ exitOnCtrlC: false, alternateScreen: true, patchConsole: true },
		);
		await instance.waitUntilExit();
	} finally {
		logs.restore();
		groundingClient.close();
	}

	const session = repl.session;
	if (session.history.length > 0 || session.evidence.all().length > 0) {
		process.stdout.write(`Session ${session.id} saved. Resume it with: ledger --resume ${session.id}\n`);
	}
}

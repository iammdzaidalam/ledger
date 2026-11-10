import { consola } from "consola";
import type { AgentEvent } from "../agent/types.js";
import type { EvidenceLog } from "../grounding/evidence.js";
import type { Evidence } from "../grounding/types.js";
import type { ActiveSession } from "../session/active.js";
import { LedgerClient } from "../swarm/client.js";
import type { RecordTurnRequest, WireEvidence } from "../swarm/types.js";

const TIMEOUT_MS = 3000;
const pending = new Set<Promise<void>>();

export type TurnSink = Pick<LedgerClient, "recordTurn">;

export function toWire(entry: Evidence): WireEvidence {
	return {
		ref: entry.ref,
		seq: entry.seq,
		tool: entry.tool,
		args: entry.args,
		rawStdout: entry.raw_stdout,
		rawStderr: entry.raw_stderr,
		...(entry.exit_code === null ? {} : { exitCode: entry.exit_code }),
		executed: entry.executed,
		isError: entry.is_error,
		durationMs: String(Math.round(entry.duration_ms)),
		...(entry.diff === undefined ? {} : { diff: entry.diff }),
	};
}

function firstUserText(session: ActiveSession): string | undefined {
	for (const message of session.history) {
		if (message.role === "user" && typeof message.content === "string") return message.content;
	}
	return undefined;
}

function assistantCount(session: ActiveSession): number {
	return session.history.filter((message) => message.role === "assistant").length;
}

export class TurnRecorder {
	private turn: number;
	private lastSeq = 0;
	private chain: Promise<void> = Promise.resolve();
	private warned = false;

	constructor(
		private readonly sink: TurnSink,
		private readonly runId: string,
		private readonly model: string,
		private readonly task: string,
		firstTurn = 0,
		private readonly onError: (message: string) => void = (message) => consola.warn(message),
	) {
		this.turn = firstTurn;
	}

	record(text: string, evidence: EvidenceLog): void {
		if (!text) return;
		const all = evidence.all();
		const fresh = all.filter((entry) => entry.seq > this.lastSeq).map((entry) => entry.ref);
		this.lastSeq = all.at(-1)?.seq ?? this.lastSeq;
		const request: RecordTurnRequest = {
			runId: this.runId,
			turn: ++this.turn,
			turnText: text,
			evidence: all.map(toWire),
			freshRefs: fresh,
			run: { source: "ledger-cli", model: this.model, task: this.task },
		};
		const job = this.chain.then(() => this.send(request));
		this.chain = job;
		pending.add(job);
		void job.finally(() => pending.delete(job));
	}

	private async send(request: RecordTurnRequest): Promise<void> {
		try {
			await this.sink.recordTurn(request);
		} catch (err) {
			if (this.warned) return;
			this.warned = true;
			this.onError(`could not record turns to the ledger server: ${(err as Error).message}`);
		}
	}

	flush(): Promise<void> {
		return this.chain;
	}
}

const recorders = new WeakMap<ActiveSession, TurnRecorder | null>();

export function recorderFor(
	session: ActiveSession,
	input: string,
	env: NodeJS.ProcessEnv = process.env,
): TurnRecorder | undefined {
	const known = recorders.get(session);
	if (known !== undefined) return known ?? undefined;
	const server = env.LEDGER_SERVER;
	if (!server) {
		recorders.set(session, null);
		return undefined;
	}
	const sink = new LedgerClient({ baseUrl: server, timeoutMs: TIMEOUT_MS, retries: 0 });
	const recorder = new TurnRecorder(
		sink,
		env.LEDGER_RUN_ID || session.id,
		session.model,
		firstUserText(session) ?? input,
		assistantCount(session),
	);
	recorders.set(session, recorder);
	return recorder;
}

export function observe(recorder: TurnRecorder | undefined, event: AgentEvent, evidence: EvidenceLog): void {
	if (recorder && event.type === "assistant_turn") recorder.record(event.text, evidence);
}

export async function flushRecorders(timeoutMs = TIMEOUT_MS): Promise<void> {
	if (pending.size === 0) return;
	const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref());
	await Promise.race([Promise.allSettled([...pending]).then(() => undefined), timer]);
}

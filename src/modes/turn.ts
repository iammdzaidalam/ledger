import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";
import { contextLimitFor, describeCompaction } from "../agent/compaction.js";
import { runAgent } from "../agent/loop.js";
import type { AgentEvent } from "../agent/types.js";
import type { GroundingClient } from "../grounding/client.js";
import { formatFlag, formatRevisionRequest, formatRevisionResult } from "../grounding/format.js";
import type { ClaimsMode } from "../grounding/types.js";
import type { RunLedger, ValidationMode } from "../grounding/validation.js";
import type { PermissionGate } from "../permissions/types.js";
import type { Provider } from "../providers/types.js";
import { observe, recorderFor } from "../server/recorder.js";
import type { ActiveSession } from "../session/active.js";

export interface TurnSettings {
	system: string;
	maxTurns?: number;
	claimsMode?: ClaimsMode;
	feedback?: boolean;
	validate?: ValidationMode;
	maxRevisions?: number;
	maxRevisionsPerRun?: number;
	permissions?: PermissionGate;
	contextLimit?: number;
	autoCompact?: boolean;
	provider?: Provider;
}

export function renderEvent(event: AgentEvent): void {
	if (event.type === "text_delta") process.stdout.write(event.delta);
	if (event.type === "tool_start") consola.info(`\n[${event.name}] ${JSON.stringify(event.input)}`);
	if (event.type === "tool_end" && event.isError) consola.warn(`[${event.name}] failed: ${event.result}`);
	if (event.type === "grounding_flag") consola.error(formatFlag(event.claim));
	if (event.type === "grounding_revision_requested") consola.info(formatRevisionRequest(event));
	if (event.type === "grounding_revision_result") consola.info(formatRevisionResult(event));
	if (event.type === "compaction") consola.info(describeCompaction(event.compaction));
}

const SETTLE_MS = 1000;

async function* untilAborted<T>(source: AsyncGenerator<T>, signal?: AbortSignal): AsyncGenerator<T> {
	if (!signal) {
		yield* source;
		return;
	}
	const stopped = new Promise<null>((resolve) => {
		if (signal.aborted) resolve(null);
		else signal.addEventListener("abort", () => resolve(null), { once: true });
	});
	try {
		while (!signal.aborted) {
			const pending = source.next();
			const next = await Promise.race([pending, stopped]);
			if (next === null) {
				const settle = sleep(SETTLE_MS, null, { ref: false });
				const late = await Promise.race([pending.catch(() => null), settle]);
				if (late && !late.done) yield late.value;
				break;
			}
			if (next.done) return;
			yield next.value;
		}
	} finally {
		if (signal.aborted) source.return(undefined).catch(() => undefined);
		else await source.return(undefined);
	}
}

export async function runTurn(
	session: ActiveSession,
	input: string,
	settings: TurnSettings,
	groundingClient: GroundingClient,
	onEvent: (event: AgentEvent) => void = renderEvent,
	signal?: AbortSignal,
): Promise<RunLedger | undefined> {
	await session.addUserMessage(input);
	const recorder = recorderFor(session, input);
	let ledger: RunLedger | undefined;
	const limit =
		settings.autoCompact === false
			? undefined
			: contextLimitFor(session.providerName, session.model, settings.contextLimit);

	const events = runAgent({
		providerName: session.providerName,
		model: session.model,
		system: settings.system,
		messages: session.history,
		maxTurns: settings.maxTurns,
		groundingClient,
		evidence: session.evidence,
		claimsMode: settings.claimsMode,
		feedback: settings.feedback,
		validate: settings.validate,
		maxRevisions: settings.maxRevisions,
		maxRevisionsPerRun: settings.maxRevisionsPerRun,
		permissions: settings.permissions,
		compaction: limit ? { contextLimit: limit } : undefined,
		provider: settings.provider,
		signal,
	});
	let ended = false;
	for await (const event of untilAborted(events, signal)) {
		await session.record(event);
		observe(recorder, event, session.evidence);
		if (event.type === "agent_end") {
			ended = true;
			ledger = event.ledger;
		}
		onEvent(event);
	}
	if (!ended && signal?.aborted) await session.cancelTurn();
	return ledger;
}

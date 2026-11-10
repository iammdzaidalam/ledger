import { setTimeout as sleep } from "node:timers/promises";
import { normalizeServerUrl } from "./client.js";
import type { SwarmEvent } from "./types.js";

export function parseSseData(block: string): SwarmEvent | undefined {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	if (!data) return undefined;
	try {
		const parsed: unknown = JSON.parse(data);
		if (!parsed || typeof parsed !== "object") return undefined;
		const raw = parsed as Record<string, unknown>;
		const pick = (snake: string, camel: string): string | undefined => {
			const value = raw[snake] ?? raw[camel];
			return typeof value === "string" ? value : undefined;
		};
		return {
			swarmId: pick("swarm_id", "swarmId"),
			taskId: pick("task_id", "taskId"),
			attemptId: pick("attempt_id", "attemptId"),
			type: pick("type", "type"),
			message: pick("message", "message"),
			at: pick("at", "at"),
		};
	} catch {
		return undefined;
	}
}

export async function* readEvents(
	baseUrl: string,
	swarmId: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	retryMs = 1000,
): AsyncGenerator<SwarmEvent> {
	const url = `${normalizeServerUrl(baseUrl)}/events?swarm=${encodeURIComponent(swarmId)}`;
	while (!signal.aborted) {
		try {
			const response = await fetchImpl(url, { headers: { accept: "text/event-stream" }, signal });
			if (!response.ok || !response.body) throw new Error(`events returned ${response.status}`);
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
				let end = buffer.indexOf("\n\n");
				while (end >= 0) {
					const event = parseSseData(buffer.slice(0, end));
					buffer = buffer.slice(end + 2);
					if (event) yield event;
					end = buffer.indexOf("\n\n");
				}
			}
		} catch {
			if (signal.aborted) return;
		}
		await sleep(retryMs, undefined, { signal }).catch(() => undefined);
	}
}

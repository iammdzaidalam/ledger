import { findModel } from "../providers/index.js";
import { ollamaSettingsFromEnv } from "../providers/ollama.js";
import type { Provider, ToolDefinition } from "../providers/types.js";
import type { Message } from "../types.js";

export type Summarizer = (transcript: string) => Promise<string>;

export interface CompactionOptions {
	contextLimit: number;
	threshold?: number;
	keepRecent?: number;
	summarize?: Summarizer;
}

export interface Compaction {
	summary: string;
	keep: number;
	before: Message[];
	messages: Message[];
	tokensBefore: number;
	tokensAfter: number;
	usedFallback: boolean;
}

export interface CompactionContext {
	provider: Provider;
	model: string;
	system: string;
	tools: ToolDefinition[];
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_THRESHOLD = 0.7;
export const DEFAULT_KEEP_RECENT = 6;
const MAX_TRANSCRIPT_CHARS = 120_000;

const SUMMARY_PROMPT = `Summarize this coding-agent conversation so the agent can carry on from it.
Keep what the user asked for, which files were read or changed, which commands ran and how each
one ended (exit code, passed or failed), decisions made, and what is still left to do. Report
outcomes exactly as the tool results show them and never turn a failure into a success.
Plain text, under 250 words.`;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function estimateTokens(messages: Message[], extra = ""): number {
	let chars = extra.length;
	for (const m of messages) {
		if (typeof m.content === "string") {
			chars += m.content.length;
			continue;
		}
		for (const block of m.content) {
			if (block.type === "text") chars += block.text.length;
			if (block.type === "tool_use") chars += block.name.length + JSON.stringify(block.input).length;
			if (block.type === "tool_result") chars += block.content.length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function contextLimitFor(providerName: string, model: string, override?: number): number | undefined {
	if (override && override > 0) return override;
	if (providerName === "ollama") return ollamaSettingsFromEnv().numCtx;
	return findModel(model)?.contextWindow;
}

function carriesToolResults(message: Message): boolean {
	return Array.isArray(message.content) && message.content.some((b) => b.type === "tool_result");
}

export function findSplit(messages: Message[], keepRecent: number): number {
	if (messages.length <= keepRecent) return 0;
	let index = Math.max(1, messages.length - Math.max(1, keepRecent));
	while (index > 0 && carriesToolResults(messages[index] as Message)) index--;
	return index;
}

export function summaryHeader(summary: string): string {
	return (
		"Summary of the earlier conversation. Older turns were compacted to fit the context window; " +
		`Ledger still checks claims against the full record of every tool call.\n${summary}`
	);
}

export function withSummary(summary: string, recent: Message[]): Message[] {
	const header = summaryHeader(summary);
	const [first, ...rest] = recent;
	if (first?.role !== "user") return [{ role: "user", content: header }, ...recent];
	const content =
		typeof first.content === "string"
			? `${header}\n\n${first.content}`
			: [{ type: "text" as const, text: `${header}\n\n` }, ...first.content];
	return [{ role: "user", content }, ...rest];
}

export function renderTranscript(messages: Message[], maxChars = MAX_TRANSCRIPT_CHARS): string {
	const lines = messages.map((m) => {
		if (typeof m.content === "string") return `${m.role}: ${clip(m.content, 2000)}`;
		const parts = m.content.map((block) => {
			if (block.type === "text") return clip(block.text, 2000);
			if (block.type === "tool_use")
				return `[called ${block.name} ${clip(JSON.stringify(block.input), 300)}]`;
			return `[${block.is_error ? "error" : "result"}: ${clip(block.content, 300)}]`;
		});
		return `${m.role}: ${parts.join(" ")}`;
	});
	const text = lines.join("\n");
	return text.length > maxChars ? `[earliest turns cut]\n${text.slice(text.length - maxChars)}` : text;
}

export function fallbackSummary(messages: Message[]): string {
	const asks: string[] = [];
	const calls: string[] = [];
	const errored = new Set<string>();
	for (const m of messages) {
		if (typeof m.content === "string") {
			if (m.role === "user") asks.push(clip(m.content.replace(/\s+/g, " "), 200));
			continue;
		}
		for (const block of m.content) {
			if (block.type === "tool_result" && block.is_error) errored.add(block.tool_use_id);
		}
	}
	for (const m of messages) {
		if (typeof m.content === "string") continue;
		for (const block of m.content) {
			if (block.type !== "tool_use") continue;
			const status = errored.has(block.id) ? "failed" : "ok";
			calls.push(`${block.name} ${clip(JSON.stringify(block.input), 120)} (${status})`);
		}
	}
	const parts = ["The summarizer was unavailable, so this is a plain list of what happened."];
	if (asks.length > 0) parts.push(`User asked:\n${asks.map((a) => `- ${a}`).join("\n")}`);
	if (calls.length > 0)
		parts.push(
			`Tool calls:\n${calls
				.slice(-30)
				.map((c) => `- ${c}`)
				.join("\n")}`,
		);
	return parts.join("\n");
}

export function providerSummarizer(provider: Provider, model: string): Summarizer {
	return async (transcript) => {
		let text = "";
		for await (const event of provider.complete({
			model,
			system: "You write short, factual summaries of coding sessions.",
			messages: [{ role: "user", content: `${SUMMARY_PROMPT}\n\n${transcript}` }],
			tools: [],
			max_tokens: 1024,
		})) {
			if (event.type === "text_delta") text += event.delta;
		}
		return text.trim();
	};
}

export async function compactHistory(
	messages: Message[],
	summarize: Summarizer | undefined,
	keepRecent = DEFAULT_KEEP_RECENT,
): Promise<Compaction | null> {
	const split = findSplit(messages, keepRecent);
	if (split <= 0) return null;

	const older = messages.slice(0, split);
	const recent = messages.slice(split);
	let summary = "";
	let usedFallback = false;
	try {
		summary = summarize ? await summarize(renderTranscript(older)) : "";
	} catch {
		summary = "";
	}
	if (!summary) {
		summary = fallbackSummary(older);
		usedFallback = true;
	}

	const compacted = withSummary(summary, recent);
	return {
		summary,
		keep: recent.length,
		before: [...messages],
		messages: compacted,
		tokensBefore: estimateTokens(messages),
		tokensAfter: estimateTokens(compacted),
		usedFallback,
	};
}

export function describeCompaction(c: Compaction): string {
	const dropped = c.before.length - c.keep;
	const fallback = c.usedFallback ? " The model summary failed, so a plain list was used." : "";
	return `Compacted ${dropped} older messages into a summary (~${c.tokensBefore} -> ~${c.tokensAfter} tokens). The evidence log is untouched.${fallback}`;
}

export async function autoCompact(
	messages: Message[],
	context: CompactionContext,
	options: CompactionOptions,
): Promise<Compaction | null> {
	const overhead = context.system + JSON.stringify(context.tools);
	const used = estimateTokens(messages, overhead);
	if (used <= options.contextLimit * (options.threshold ?? DEFAULT_THRESHOLD)) return null;
	const summarize = options.summarize ?? providerSummarizer(context.provider, context.model);
	return compactHistory(messages, summarize, options.keepRecent);
}

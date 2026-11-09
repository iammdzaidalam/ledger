import type { Provider } from "./types.js";

export type ProviderErrorKind =
	| "auth"
	| "rate_limit"
	| "context_length"
	| "network"
	| "model_not_found"
	| "server"
	| "unknown";

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly kind: ProviderErrorKind,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ProviderError";
	}
}

const LABELS: Record<string, string> = {
	claude: "Claude API",
	gemini: "Gemini API",
	groq: "Groq API",
	ollama: "Ollama",
};

const KEY_ENV: Record<string, string> = {
	claude: "ANTHROPIC_API_KEY",
	gemini: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
};

const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"ETIMEDOUT",
	"ECONNRESET",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

interface ErrorFacts {
	status?: number;
	code?: string;
	name: string;
	text: string;
	retryAfter?: number;
}

export function httpError(status: number, body: string): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status} ${body}`.trim()), { status });
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function facts(err: unknown): ErrorFacts {
	const e = record(err) ?? {};
	const cause = record(e.cause);
	const body = record(e.error);
	const inner = record(body?.error);
	const status = typeof e.status === "number" ? e.status : undefined;
	const codes = [e.code, cause?.code, inner?.code, body?.code, inner?.type, body?.type];
	const code = codes.find((c): c is string => typeof c === "string");
	const message = err instanceof Error ? err.message : String(err);
	const text = [message, body ? JSON.stringify(body) : "", cause?.message ?? ""].join(" ");
	return {
		status,
		code,
		name: err instanceof Error ? err.constructor.name : "",
		text,
		retryAfter: retryAfter(e),
	};
}

function retryAfter(e: Record<string, unknown>): number | undefined {
	const headers = record(e.headers);
	const raw =
		typeof headers?.get === "function"
			? (headers.get as (k: string) => string | null)("retry-after")
			: headers?.["retry-after"];
	const fromHeader = typeof raw === "string" ? Number(raw) : Number.NaN;
	if (Number.isFinite(fromHeader)) return Math.ceil(fromHeader);
	const message = e instanceof Error ? e.message : "";
	const fromText = /retry in ([\d.]+)\s*s/i.exec(message)?.[1];
	return fromText ? Math.ceil(Number(fromText)) : undefined;
}

export function classifyProviderError(err: unknown): ProviderErrorKind {
	const f = facts(err);
	if (
		f.name === "APIConnectionError" ||
		f.name === "APIConnectionTimeoutError" ||
		(f.code !== undefined && NETWORK_CODES.has(f.code)) ||
		(f.status === undefined &&
			/fetch failed|ECONNREFUSED|getaddrinfo|socket hang up|network error/i.test(f.text))
	) {
		return "network";
	}
	if (
		f.code === "context_length_exceeded" ||
		/prompt is too long|context.length|context window|maximum context|exceeds the maximum number of tokens|reduce the length of the messages|input length exceeds/i.test(
			f.text,
		)
	) {
		return "context_length";
	}
	if (f.status === 429 || /rate.?limit|RESOURCE_EXHAUSTED|quota|too many requests/i.test(f.text)) {
		return "rate_limit";
	}
	if (
		f.status === 401 ||
		f.status === 403 ||
		/invalid.{0,3}api.?key|api key not valid|authentication_error|x-api-key|unauthorized/i.test(f.text)
	) {
		return "auth";
	}
	if (
		f.status === 404 ||
		f.code === "model_not_found" ||
		f.code === "not_found_error" ||
		/model.{0,80}(not found|does not exist)|is not found for API version/i.test(f.text)
	) {
		return "model_not_found";
	}
	if ((f.status !== undefined && f.status >= 500) || /overloaded/i.test(f.text)) return "server";
	return "unknown";
}

function innermostMessage(text: string): string {
	const found = [...text.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
		.map((m) => (m[1] ?? "").replace(/\\n/g, " ").replace(/\\"/g, '"').trim())
		.filter((m) => m.length > 0 && !m.startsWith("{"));
	const message = found.at(-1) ?? text.trim().split("\n")[0] ?? "";
	return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

export function describeProviderError(
	err: unknown,
	providerName: string,
	model: string,
	ollamaHost = "http://127.0.0.1:11434",
): string {
	const label = LABELS[providerName] ?? providerName;
	const f = facts(err);
	const status = f.status ? ` (HTTP ${f.status})` : "";
	const local = providerName === "ollama";

	switch (classifyProviderError(err)) {
		case "auth":
			return local
				? `Ollama refused the request${status}.`
				: `${label} rejected the API key${status}. Check ${KEY_ENV[providerName] ?? "the API key"}.`;
		case "rate_limit": {
			const wait = f.retryAfter ? ` Retry in about ${f.retryAfter}s,` : " Wait a bit and retry,";
			return `${label} rate limit or quota reached for ${model}.${wait} or switch with --model or /model.`;
		}
		case "context_length":
			return local
				? `${model} ran out of context. Run /compact or /clear, or raise LEDGER_OLLAMA_NUM_CTX.`
				: `The conversation is longer than ${model}'s context window. Run /compact or /clear.`;
		case "network":
			return local
				? `Could not reach Ollama at ${ollamaHost}. Is it running? Start it with \`ollama serve\`.`
				: `Could not reach the ${label}${f.code ? ` (${f.code})` : ""}. Check the network connection.`;
		case "model_not_found":
			return local
				? `Ollama has no model "${model}". Pull it with \`ollama pull ${model}\`.`
				: `${label} does not know the model "${model}"${status}. Run /model to see the known ids.`;
		case "server":
			return `${label} had a server error${status}. Try again in a moment.`;
		default:
			return `${label} error${status}: ${innermostMessage(f.text)}`;
	}
}

export function readableError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function withReadableErrors(provider: Provider, ollamaHost?: string): Provider {
	return {
		name: provider.name,
		async *complete(options) {
			try {
				yield* provider.complete(options);
			} catch (err) {
				if (err instanceof ProviderError) throw err;
				const message = describeProviderError(err, provider.name, options.model, ollamaHost);
				throw new ProviderError(message, classifyProviderError(err), { cause: err });
			}
		},
	};
}

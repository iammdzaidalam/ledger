import { createClaudeProvider } from "./claude.js";
import { createGeminiProvider } from "./gemini.js";
import { createGroqProvider } from "./groq.js";
import type { ModelInfo, Provider } from "./types.js";

export const MODELS: ModelInfo[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		provider: "claude",
		contextWindow: 200_000,
		maxOutputTokens: 8192,
	},
	{
		id: "claude-opus-4-1",
		name: "Claude Opus 4.1",
		provider: "claude",
		contextWindow: 200_000,
		maxOutputTokens: 8192,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		provider: "gemini",
		contextWindow: 1_000_000,
		maxOutputTokens: 8192,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		provider: "gemini",
		contextWindow: 1_000_000,
		maxOutputTokens: 8192,
	},
	{
		id: "llama-3.3-70b-versatile",
		name: "Llama 3.3 70B",
		provider: "groq",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
	},
	{
		id: "llama-3.1-8b-instant",
		name: "Llama 3.1 8B Instant",
		provider: "groq",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
	},
];

export function createProvider(providerName: string, apiKey: string): Provider {
	if (providerName === "claude") return createClaudeProvider(apiKey);
	if (providerName === "gemini") return createGeminiProvider(apiKey);
	if (providerName === "groq") return createGroqProvider(apiKey);
	throw new Error(`Unknown provider: ${providerName}`);
}

export function defaultModelFor(providerName: string): string {
	const match = MODELS.find((m) => m.provider === providerName);
	if (!match) throw new Error(`No models registered for provider: ${providerName}`);
	return match.id;
}

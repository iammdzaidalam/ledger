import { createClaudeProvider } from "./claude.js";
import { withReadableErrors } from "./errors.js";
import { createGeminiProvider } from "./gemini.js";
import { createGroqProvider } from "./groq.js";
import { createOllamaProvider, ollamaSettingsFromEnv } from "./ollama.js";
import type { ModelInfo, Provider } from "./types.js";

export const PROVIDERS = ["claude", "gemini", "groq", "ollama"] as const;

const model = (
	id: string,
	name: string,
	provider: string,
	contextWindow: number,
	maxOutputTokens = 8192,
): ModelInfo => ({ id, name, provider, contextWindow, maxOutputTokens });

export const MODELS: ModelInfo[] = [
	model("claude-sonnet-5-5", "Claude Sonnet 5.5", "claude", 200_000),
	model("claude-opus-5-5", "Claude Opus 5.5", "claude", 200_000),
	model("claude-haiku-4-5", "Claude Haiku 4.5", "claude", 200_000),
	model("claude-sonnet-4-5", "Claude Sonnet 4.5", "claude", 200_000),
	model("gemini-2.5-pro", "Gemini 2.5 Pro", "gemini", 1_048_576),
	model("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini", 1_048_576),
	model("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", "gemini", 1_048_576),
	model("gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)", "gemini", 1_048_576),
	model("gemini-3-flash-preview", "Gemini 3 Flash (preview)", "gemini", 1_048_576),
	model("openai/gpt-oss-120b", "GPT-OSS 120B", "groq", 131_072),
	model("openai/gpt-oss-20b", "GPT-OSS 20B", "groq", 131_072),
	model("llama-3.3-70b-versatile", "Llama 3.3 70B", "groq", 131_072),
	model("llama-3.1-8b-instant", "Llama 3.1 8B Instant", "groq", 131_072),
	model("qwen2.5:7b", "Qwen 2.5 7B (local)", "ollama", 32_768, 4096),
	model("llama3.1:8b", "Llama 3.1 8B (local)", "ollama", 131_072, 4096),
	model("qwen2.5:3b", "Qwen 2.5 3B (local)", "ollama", 32_768, 4096),
];

function createRawProvider(providerName: string, apiKey: string): Provider {
	if (providerName === "claude") return createClaudeProvider(apiKey);
	if (providerName === "gemini") return createGeminiProvider(apiKey);
	if (providerName === "groq") return createGroqProvider(apiKey);
	if (providerName === "ollama") return createOllamaProvider();
	throw new Error(`Unknown provider: ${providerName}`);
}

export function createProvider(providerName: string, apiKey: string): Provider {
	return withReadableErrors(createRawProvider(providerName, apiKey), ollamaSettingsFromEnv().host);
}

export function findModel(id: string): ModelInfo | undefined {
	return MODELS.find((m) => m.id === id);
}

export function modelsFor(providerName: string): ModelInfo[] {
	return MODELS.filter((m) => m.provider === providerName);
}

export function isKnownModel(providerName: string, id: string): boolean {
	return providerName === "ollama" || findModel(id)?.provider === providerName;
}

export function defaultModelFor(providerName: string): string {
	const match = MODELS.find((m) => m.provider === providerName);
	if (!match) throw new Error(`No models registered for provider: ${providerName}`);
	return match.id;
}

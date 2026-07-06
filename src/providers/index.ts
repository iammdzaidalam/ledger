import { createClaudeProvider } from "./claude.js";
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
];

export function createProvider(providerName: string, apiKey: string): Provider {
	if (providerName === "claude") return createClaudeProvider(apiKey);
	throw new Error(`Unknown provider: ${providerName}`);
}

export function defaultModelFor(providerName: string): string {
	const match = MODELS.find((m) => m.provider === providerName);
	if (!match) throw new Error(`No models registered for provider: ${providerName}`);
	return match.id;
}

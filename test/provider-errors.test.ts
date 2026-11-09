import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";
import * as Groq from "groq-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyProviderError, describeProviderError, ProviderError } from "../src/providers/errors.js";
import { createProvider, findModel, isKnownModel, MODELS } from "../src/providers/index.js";
import type { Provider } from "../src/providers/types.js";

const anthropic = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
	Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, headers);

const groq = (status: number, code: string, message: string) =>
	Groq.APIError.generate(status, { error: { message, type: "invalid_request_error", code } }, undefined, {});

const gemini = (status: number, statusText: string, message: string) =>
	new GeminiApiError({
		status,
		message: JSON.stringify({ error: { code: status, message, status: statusText } }),
	});

async function drain(provider: Provider, model: string): Promise<unknown> {
	try {
		for await (const _ of provider.complete({ model, system: "", messages: [], tools: [], max_tokens: 10 })) {
		}
		return undefined;
	} catch (err) {
		return err;
	}
}

describe("readable provider errors", () => {
	it("explains auth failures with the env var to check", () => {
		expect(
			describeProviderError(anthropic(401, "authentication_error", "invalid x-api-key"), "claude", "m"),
		).toBe("Claude API rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY.");
		const badGeminiKey = gemini(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.");
		expect(classifyProviderError(badGeminiKey)).toBe("auth");
		expect(describeProviderError(badGeminiKey, "gemini", "m")).toContain("GEMINI_API_KEY");
		expect(describeProviderError(groq(401, "invalid_api_key", "Invalid API Key"), "groq", "m")).toContain(
			"GROQ_API_KEY",
		);
	});

	it("explains rate limits, with the retry hint when there is one", () => {
		const limited = anthropic(429, "rate_limit_error", "Number of requests has exceeded your rate limit", {
			"retry-after": "20",
		});
		expect(describeProviderError(limited, "claude", "claude-sonnet-5-5")).toBe(
			"Claude API rate limit or quota reached for claude-sonnet-5-5. Retry in about 20s, or switch with --model or /model.",
		);
		const quota = gemini(
			429,
			"RESOURCE_EXHAUSTED",
			"You exceeded your current quota. Please retry in 41.6s.",
		);
		expect(describeProviderError(quota, "gemini", "gemini-2.5-pro")).toContain("Retry in about 42s");
	});

	it("explains context-length failures and points at /compact", () => {
		const cases: Array<[unknown, string]> = [
			[
				anthropic(400, "invalid_request_error", "prompt is too long: 212000 tokens > 200000 maximum"),
				"claude",
			],
			[
				groq(400, "context_length_exceeded", "Please reduce the length of the messages or completion."),
				"groq",
			],
			[
				gemini(
					400,
					"INVALID_ARGUMENT",
					"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
				),
				"gemini",
			],
		];
		for (const [err, provider] of cases) {
			expect(classifyProviderError(err)).toBe("context_length");
			expect(describeProviderError(err, provider, "m")).toContain("/compact");
		}
	});

	it("explains unknown models", () => {
		const err = groq(
			404,
			"model_not_found",
			"The model `llama3-70b-8192` does not exist or you do not have access to it.",
		);
		expect(describeProviderError(err, "groq", "llama3-70b-8192")).toBe(
			'Groq API does not know the model "llama3-70b-8192" (HTTP 404). Run /model to see the known ids.',
		);
		const geminiMissing = gemini(404, "NOT_FOUND", "models/gemini-9 is not found for API version v1beta");
		expect(classifyProviderError(geminiMissing)).toBe("model_not_found");
	});

	it("explains network failures and server errors", () => {
		const offline = new Anthropic.APIConnectionError({
			message: "Connection error.",
			cause: new Error("ECONNREFUSED"),
		});
		expect(classifyProviderError(offline)).toBe("network");
		expect(describeProviderError(offline, "claude", "m")).toContain("Could not reach the Claude API");
		expect(classifyProviderError(anthropic(529, "overloaded_error", "Overloaded"))).toBe("server");
	});

	it("falls back to the innermost message for anything else", () => {
		const odd = anthropic(400, "invalid_request_error", "messages.0.content: field required");
		expect(describeProviderError(odd, "claude", "m")).toBe(
			"Claude API error (HTTP 400): messages.0.content: field required",
		);
	});
});

describe("ollama errors end to end", () => {
	let server: Server;
	let host: string;
	const previousHost = process.env.OLLAMA_HOST;

	beforeAll(async () => {
		server = createServer((_req, res) => {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: 'model "nope:1b" not found, try pulling it first' }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		if (previousHost === undefined) delete process.env.OLLAMA_HOST;
		else process.env.OLLAMA_HOST = previousHost;
		await new Promise((resolve) => server.close(resolve));
	});

	it("says to pull a missing model", async () => {
		process.env.OLLAMA_HOST = host;
		const err = await drain(createProvider("ollama", ""), "nope:1b");
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).message).toBe(
			'Ollama has no model "nope:1b". Pull it with `ollama pull nope:1b`.',
		);
		expect((err as ProviderError).kind).toBe("model_not_found");
	});

	it("says Ollama is not running when nothing listens", async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
		const port = (closed.address() as AddressInfo).port;
		await new Promise((resolve) => closed.close(resolve));
		process.env.OLLAMA_HOST = `127.0.0.1:${port}`;
		const err = await drain(createProvider("ollama", ""), "qwen2.5:7b");
		expect((err as ProviderError).kind).toBe("network");
		expect((err as ProviderError).message).toBe(
			`Could not reach Ollama at http://127.0.0.1:${port}. Is it running? Start it with \`ollama serve\`.`,
		);
	});
});

describe("model list", () => {
	it("has unique ids and one default per provider", () => {
		expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
		expect(findModel("openai/gpt-oss-120b")?.provider).toBe("groq");
		expect(isKnownModel("groq", "claude-sonnet-5-5")).toBe(false);
		expect(isKnownModel("ollama", "any:tag")).toBe(true);
	});
});

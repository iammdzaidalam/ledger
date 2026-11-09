import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaimsMode } from "../grounding/types.js";
import { getToolDefinitions } from "../tools/index.js";

const BASE_PROMPT = `You are Ledger, a terminal coding agent with access to a small set of tools
(Read, Write, Edit, Bash, Grep, Find, Ls). Use them to inspect and modify the user's
project. Only claim a command succeeded if the tool output actually shows it did -
if a tool errors or times out, say so plainly instead of guessing at the outcome.`;

const TAGGED_CLAIMS_PROMPT = `Every tool result starts with a reference like [ref c3]. Whenever you
report what a tool call did, wrap that statement in a claim tag naming the reference, for example:
<claim ref="c3">all 12 tests pass</claim> or <claim ref="c4">created src/config.json</claim>.
One claim per tag. Report failures the same way.`;

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", ".context", join(".ledger", "context.md")];

async function readFirstExistingContextFile(): Promise<string | null> {
	for (const candidate of CONTEXT_FILE_CANDIDATES) {
		try {
			return await readFile(candidate, "utf-8");
		} catch {
			// not there, try the next one
		}
	}
	return null;
}

export async function buildSystemPrompt(extra?: string, claimsMode: ClaimsMode = "prose"): Promise<string> {
	const tools = getToolDefinitions();
	const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
	const contextFile = await readFirstExistingContextFile();

	const parts = [BASE_PROMPT, `Available tools:\n${toolList}`];
	if (claimsMode === "tagged") parts.push(TAGGED_CLAIMS_PROMPT);
	if (contextFile) parts.push(`Project context:\n${contextFile}`);
	if (extra) parts.push(extra);

	return parts.join("\n\n");
}

import type { ContentBlock } from "../types.js";

// v1 doesn't try to figure out which claim belongs to which tool call - it
// just attaches the model's full next-turn text to every still-unchecked
// pending result. Crude, but the PRD accepts early false positives for v1.
export function extractClaimText(blocks: ContentBlock[]): string | null {
	const text = blocks
		.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
	return text.length > 0 ? text : null;
}

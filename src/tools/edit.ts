import { readFile, writeFile } from "node:fs/promises";
import { unifiedDiff } from "./diff.js";
import type { Tool, ToolResult } from "./types.js";
import { errorResult, fileExecution, okResult } from "./types.js";
import { outsideWorkspace } from "./workspace.js";

async function applyEdit(input: Record<string, unknown>): Promise<{ result: ToolResult; diff: string }> {
	const path = input.path as string;
	const oldString = input.old_string as string;
	const newString = input.new_string as string;

	if (outsideWorkspace(path)) throw new Error(`${path} is outside the workspace`);
	const content = await readFile(path, "utf-8");
	const firstIndex = content.indexOf(oldString);
	if (firstIndex === -1) return { result: errorResult(`old_string not found in ${path}`), diff: "" };

	const lastIndex = content.lastIndexOf(oldString);
	if (firstIndex !== lastIndex) {
		return {
			result: errorResult(`old_string matches more than once in ${path}, make it more specific`),
			diff: "",
		};
	}

	const updated = content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
	await writeFile(path, updated, "utf-8");
	return { result: okResult(`Edited ${path}`), diff: unifiedDiff(path, content, updated) };
}

export const editTool: Tool = {
	name: "Edit",
	evidence: { tool: "Edit", args: (input) => ({ path: input.path }) },
	description:
		"Replace an exact, unique string in a file with another string. Fails if old_string " +
		"isn't found or matches more than once, unique matches are the whole point.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file" },
			old_string: { type: "string", description: "Exact text to find, must be unique in the file" },
			new_string: { type: "string", description: "Text to replace it with" },
		},
		required: ["path", "old_string", "new_string"],
	},

	async execute(input, meta): Promise<ToolResult> {
		const startedAt = Date.now();
		const { result, diff } = await applyEdit(input).catch((err) => ({ result: errorResult(err), diff: "" }));
		meta?.onExecution?.(fileExecution(input, startedAt, result, diff));
		return result;
	},
};

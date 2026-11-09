import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { unifiedDiff } from "./diff.js";
import type { Tool, ToolResult } from "./types.js";
import { errorResult, fileExecution, okResult } from "./types.js";
import { outsideWorkspace } from "./workspace.js";

export const writeTool: Tool = {
	name: "Write",
	description: "Create a file or overwrite it entirely. Makes parent directories as needed.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to write" },
			content: { type: "string", description: "Full file content" },
		},
		required: ["path", "content"],
	},

	async execute(input, meta): Promise<ToolResult> {
		const startedAt = Date.now();
		let diff = "";
		let result: ToolResult;
		try {
			const path = input.path as string;
			const content = input.content as string;
			if (outsideWorkspace(path)) throw new Error(`${path} is outside the workspace`);
			const before = await readFile(path, "utf-8").catch(() => "");
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf-8");
			diff = unifiedDiff(path, before, content);
			result = okResult(`Wrote ${content.length} bytes to ${path}`);
		} catch (err) {
			result = errorResult(err);
		}
		meta?.onExecution?.(fileExecution(input, startedAt, result, diff));
		return result;
	},
};

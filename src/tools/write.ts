import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

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

	async execute(input): Promise<ReturnType<typeof okResult>> {
		try {
			const path = input.path as string;
			const content = input.content as string;
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf-8");
			return okResult(`Wrote ${content.length} bytes to ${path}`);
		} catch (err) {
			return errorResult(err);
		}
	},
};

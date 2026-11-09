import { readFile } from "node:fs/promises";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

export const readTool: Tool = {
	name: "Read",
	readOnly: true,
	description: "Read a file's contents. Returns text with line numbers, optionally offset/limited.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file" },
			offset: { type: "number", description: "Line number to start from (1-indexed)" },
			limit: { type: "number", description: "Max number of lines to return" },
		},
		required: ["path"],
	},

	async execute(input): Promise<ReturnType<typeof okResult>> {
		try {
			const path = input.path as string;
			const raw = await readFile(path, "utf-8");
			const lines = raw.split("\n");

			const offset = (input.offset as number | undefined) ?? 1;
			const limit = (input.limit as number | undefined) ?? lines.length;
			const slice = lines.slice(offset - 1, offset - 1 + limit);

			if (slice.length === 0) return okResult("(empty file or offset past end)");

			const numbered = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
			return okResult(numbered);
		} catch (err) {
			return errorResult(err);
		}
	},
};

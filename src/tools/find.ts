import { glob } from "glob";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

export const findTool: Tool = {
	name: "Find",
	description: "Find files by glob pattern (e.g. src/**/*.ts).",
	inputSchema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Glob pattern" },
		},
		required: ["pattern"],
	},

	async execute(input): Promise<ReturnType<typeof okResult>> {
		try {
			const pattern = input.pattern as string;
			const files = await glob(pattern, { ignore: "node_modules/**" });
			if (files.length === 0) return okResult("No files matched");
			return okResult(files.sort().join("\n"));
		} catch (err) {
			return errorResult(err);
		}
	},
};

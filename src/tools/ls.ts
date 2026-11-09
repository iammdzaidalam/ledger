import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

export const lsTool: Tool = {
	name: "Ls",
	readOnly: true,
	description: "List a directory's entries with type and size.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list, defaults to cwd" },
		},
	},

	async execute(input): Promise<ReturnType<typeof okResult>> {
		try {
			const path = (input.path as string | undefined) ?? ".";
			const entries = await readdir(path);
			const lines = await Promise.all(
				entries.map(async (name) => {
					const s = await stat(join(path, name));
					const kind = s.isDirectory() ? "dir" : "file";
					return `${kind}\t${s.size}\t${name}`;
				}),
			);
			if (lines.length === 0) return okResult("(empty directory)");
			return okResult(lines.join("\n"));
		} catch (err) {
			return errorResult(err);
		}
	},
};

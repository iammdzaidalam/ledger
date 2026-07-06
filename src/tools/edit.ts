import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

export const editTool: Tool = {
	name: "Edit",
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

	async execute(input): Promise<ReturnType<typeof okResult>> {
		try {
			const path = input.path as string;
			const oldString = input.old_string as string;
			const newString = input.new_string as string;

			const content = await readFile(path, "utf-8");
			const firstIndex = content.indexOf(oldString);
			if (firstIndex === -1) return errorResult(`old_string not found in ${path}`);

			const lastIndex = content.lastIndexOf(oldString);
			if (firstIndex !== lastIndex) {
				return errorResult(`old_string matches more than once in ${path}, make it more specific`);
			}

			const updated = content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
			await writeFile(path, updated, "utf-8");
			return okResult(`Edited ${path}`);
		} catch (err) {
			return errorResult(err);
		}
	},
};

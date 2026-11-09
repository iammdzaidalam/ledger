import { readFile } from "node:fs/promises";
import { glob } from "glob";
import type { Tool } from "./types.js";
import { errorResult, okResult } from "./types.js";

const MAX_MATCHES = 200;

export const grepTool: Tool = {
	name: "Grep",
	readOnly: true,
	description: "Search file contents with a regex, across a glob of files.",
	inputSchema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regex pattern to search for" },
			glob: { type: "string", description: "Glob of files to search, defaults to **/*" },
		},
		required: ["pattern"],
	},

	async execute(input): Promise<ReturnType<typeof okResult>> {
		try {
			const pattern = new RegExp(input.pattern as string);
			const globPattern = (input.glob as string | undefined) ?? "**/*";
			const files = await glob(globPattern, { nodir: true, ignore: "node_modules/**" });

			const matches: string[] = [];
			for (const file of files) {
				if (matches.length >= MAX_MATCHES) break;
				let text: string;
				try {
					text = await readFile(file, "utf-8");
				} catch {
					continue; // binary or unreadable, skip it
				}
				const lines = text.split("\n");
				for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
					if (pattern.test(lines[i]!)) matches.push(`${file}:${i + 1}:${lines[i]}`);
				}
			}

			if (matches.length === 0) return okResult("No matches");
			return okResult(matches.join("\n"));
		} catch (err) {
			return errorResult(err);
		}
	},
};

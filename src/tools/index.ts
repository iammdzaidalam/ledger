import type { ToolDefinition } from "../providers/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

const registry: Tool[] = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool];

export function getTool(name: string): Tool | undefined {
	return registry.find((t) => t.name === name);
}

export function getToolDefinitions(): ToolDefinition[] {
	return registry.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.inputSchema,
	}));
}

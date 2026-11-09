import type { ToolDefinition } from "../providers/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { GIT_TOOLS } from "./git.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

const registry: Tool[] = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool, ...GIT_TOOLS];

export const CORE_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Find", "Ls"] as const;

export function getTools(only?: readonly string[]): Tool[] {
	return only ? registry.filter((t) => only.includes(t.name)) : registry;
}

export function getTool(name: string, only?: readonly string[]): Tool | undefined {
	return getTools(only).find((t) => t.name === name);
}

export function getToolDefinitions(only?: readonly string[]): ToolDefinition[] {
	return getTools(only).map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.inputSchema,
	}));
}

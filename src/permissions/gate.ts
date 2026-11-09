import type { RawExecution, Tool, ToolResult } from "../tools/types.js";
import type { PermissionDecision, PermissionGate, PermissionRequest } from "./types.js";

export function describeCall(tool: Tool, input: Record<string, unknown>): string {
	const command = tool.evidence?.args(input).command;
	if (typeof command === "string") return command;
	if (typeof input.path === "string") return `${tool.name} ${input.path}`;
	return `${tool.name} ${JSON.stringify(input)}`;
}

export function permissionRequest(tool: Tool, input: Record<string, unknown>): PermissionRequest {
	return { tool: tool.name, input, summary: describeCall(tool, input) };
}

export async function checkPermission(
	gate: PermissionGate | undefined,
	tool: Tool,
	input: Record<string, unknown>,
): Promise<PermissionDecision> {
	if (!gate || tool.readOnly) return { allow: true };
	return gate.check(permissionRequest(tool, input));
}

export function deniedCall(
	tool: Tool,
	input: Record<string, unknown>,
	reason: string,
): { result: ToolResult; execution?: RawExecution } {
	const result: ToolResult = {
		output: `Permission denied: ${reason}. The call did not run and nothing changed.`,
		isError: true,
	};
	if (!tool.evidence) return { result };
	return {
		result,
		execution: {
			args: tool.evidence.args(input),
			raw_stdout: "",
			raw_stderr: `permission denied: ${reason}`,
			exit_code: null,
			executed: false,
			is_error: true,
			duration_ms: 0,
		},
	};
}

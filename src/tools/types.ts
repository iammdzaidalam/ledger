// What a tool hands back after execution.
export interface ToolResult {
	output: string; // text sent back to the model
	isError: boolean;
}

// Raw execution evidence a tool can hand off for grounding, on the side, without
// changing what it returns to the model. Only bash.ts populates this today.
export interface RawExecution {
	args: Record<string, unknown>;
	raw_stdout: string;
	raw_stderr: string;
	exit_code: number | null;
	executed: boolean;
	duration_ms: number;
}

export interface ToolExecMeta {
	onExecution?: (exec: RawExecution) => void;
}

// Every tool implements this. inputSchema is what the model sees.
export interface Tool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute(input: Record<string, unknown>, meta?: ToolExecMeta): Promise<ToolResult>;
}

export function errorResult(err: unknown): ToolResult {
	const msg = err instanceof Error ? err.message : String(err);
	return { output: `Error: ${msg}`, isError: true };
}

export function okResult(output: string): ToolResult {
	return { output, isError: false };
}

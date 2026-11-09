// What a tool hands back after execution.
export interface ToolResult {
	output: string; // text sent back to the model
	isError: boolean;
}

export interface RawExecution {
	args: Record<string, unknown>;
	raw_stdout: string;
	raw_stderr: string;
	exit_code: number | null;
	executed: boolean;
	is_error: boolean;
	duration_ms: number;
	diff?: string;
}

export interface ToolExecMeta {
	onExecution?: (exec: RawExecution) => void;
	signal?: AbortSignal;
}

export interface EvidenceSpec {
	tool: string;
	args(input: Record<string, unknown>): Record<string, unknown>;
}

// Every tool implements this. inputSchema is what the model sees.
export interface Tool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly?: boolean;
	evidence?: EvidenceSpec;
	execute(input: Record<string, unknown>, meta?: ToolExecMeta): Promise<ToolResult>;
}

export function errorResult(err: unknown): ToolResult {
	const msg = err instanceof Error ? err.message : String(err);
	return { output: `Error: ${msg}`, isError: true };
}

export function okResult(output: string): ToolResult {
	return { output, isError: false };
}

export function fileExecution(
	input: Record<string, unknown>,
	startedAt: number,
	result: ToolResult,
	diff = "",
): RawExecution {
	return {
		args: { path: input.path },
		raw_stdout: result.isError ? "" : result.output,
		raw_stderr: result.isError ? result.output : "",
		exit_code: null,
		executed: true,
		is_error: result.isError,
		duration_ms: Date.now() - startedAt,
		diff,
	};
}

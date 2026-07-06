// What bash.ts captures at execution time, before there's any claim to check against.
export interface ToolExecution {
	tool: string;
	args: Record<string, unknown>;
	raw_stdout: string;
	raw_stderr: string;
	exit_code: number | null;
	executed: boolean;
	duration_ms: number;
}

export interface CheckRequest extends ToolExecution {
	request_id: string;
	model_claimed: string | null;
}

export interface VerifiedResult extends ToolExecution {
	request_id: string;
	claim_check: {
		model_claimed: string | null;
		matches_evidence: boolean | "unverifiable";
	};
}

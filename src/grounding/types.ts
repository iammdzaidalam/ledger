export interface Evidence {
	ref: string;
	seq: number;
	tool: string;
	args: Record<string, unknown>;
	raw_stdout: string;
	raw_stderr: string;
	exit_code: number | null;
	executed: boolean;
	is_error: boolean;
	duration_ms: number;
	diff?: string;
}

export interface CheckRequest {
	request_id: string;
	turn_text: string;
	evidence: Evidence[];
	fresh_refs: string[];
}

export type ClaimKind = "tests_pass" | "file_created" | "bug_fixed" | "lint_clean" | "command_success";

export type Verdict = "verified" | "contradicted" | "unsupported" | "unverifiable";

export interface ClaimResult {
	text: string;
	kind: ClaimKind;
	ref?: string;
	attribution: "tag" | "mention" | "family" | "recency" | "none";
	verdict: Verdict;
	rule: string;
	reason: string;
}

export interface CheckResponse {
	request_id: string;
	claims: ClaimResult[];
	error?: string;
}

export type ClaimsMode = "prose" | "tagged";

// Shared message shape every provider translates to and from.

export type Role = "user" | "assistant" | "system";

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
	role: Role;
	content: string | ContentBlock[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface Usage {
	input_tokens: number;
	output_tokens: number;
}

export type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
export type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

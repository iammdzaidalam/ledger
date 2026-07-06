import type { GroundingClient } from "../grounding/client.js";
import type { VerifiedResult } from "../grounding/types.js";
import type { Message, StopReason, Usage } from "../types.js";

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "text_delta"; delta: string }
	| { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_end"; id: string; name: string; result: string; isError: boolean }
	| { type: "turn_end"; stop_reason: StopReason; usage: Usage }
	| { type: "grounding_flag"; result: VerifiedResult }
	| { type: "agent_end"; messages: Message[] };

export interface AgentOptions {
	providerName: string;
	model: string;
	system: string;
	messages: Message[];
	maxTurns?: number;
	// shared across turns within one CLI run so the checker subprocess is
	// spawned once, not once per call to runAgent()
	groundingClient: GroundingClient;
}

import type { GroundingClient } from "../grounding/client.js";
import type { EvidenceLog } from "../grounding/evidence.js";
import type { ClaimResult, ClaimsMode, Evidence } from "../grounding/types.js";
import type { RevisionRequest, RevisionResult, RunLedger, ValidationMode } from "../grounding/validation.js";
import type { PermissionGate } from "../permissions/types.js";
import type { Provider } from "../providers/types.js";
import type { Message, StopReason, Usage } from "../types.js";
import type { Compaction, CompactionOptions } from "./compaction.js";

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "text_delta"; delta: string }
	| { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_end"; id: string; name: string; result: string; isError: boolean }
	| { type: "evidence"; entry: Evidence; toolUseId?: string }
	| { type: "turn_end"; stop_reason: StopReason; usage: Usage }
	| { type: "assistant_turn"; turn: number; text: string; toolCalls: number }
	| { type: "grounding_check"; turn: number; claims: ClaimResult[]; error?: string; latencyMs: number }
	| { type: "grounding_flag"; claim: ClaimResult }
	| ({ type: "grounding_revision_requested" } & RevisionRequest)
	| ({ type: "grounding_revision_result" } & RevisionResult)
	| { type: "compaction"; compaction: Compaction }
	| { type: "agent_end"; messages: Message[]; ledger?: RunLedger };

export interface AgentOptions {
	providerName: string;
	model: string;
	system: string;
	messages: Message[];
	maxTurns?: number;
	temperature?: number;
	groundingClient: GroundingClient;
	evidence: EvidenceLog;
	claimsMode?: ClaimsMode;
	feedback?: boolean;
	validate?: ValidationMode;
	maxRevisions?: number;
	maxRevisionsPerRun?: number;
	provider?: Provider;
	permissions?: PermissionGate;
	tools?: readonly string[];
	signal?: AbortSignal;
	compaction?: CompactionOptions;
}

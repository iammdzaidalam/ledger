export type PermissionMode = "ask" | "allow" | "deny";

export interface PermissionRequest {
	tool: string;
	input: Record<string, unknown>;
	summary: string;
}

export type PermissionDecision = { allow: true } | { allow: false; reason: string };

export type PermissionAnswer = { kind: "once" } | { kind: "session" } | { kind: "deny"; reason?: string };

export type Asker = (request: PermissionRequest, sessionRules: string[]) => Promise<PermissionAnswer>;

export interface PermissionGate {
	check(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionSettings {
	mode?: PermissionMode;
	allow?: string[];
}

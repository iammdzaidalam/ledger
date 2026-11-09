import type { ValidationMode } from "../grounding/validation.js";
import type { PermissionSettings } from "../permissions/types.js";

export interface Settings {
	provider?: string;
	model?: string;
	systemPromptExtra?: string;
	maxTurns?: number;
	claimsMode?: "prose" | "tagged";
	validate?: ValidationMode;
	maxRevisions?: number;
	maxRevisionsPerRun?: number;
	feedback?: boolean;
	permissions?: PermissionSettings;
	contextLimit?: number;
	autoCompact?: boolean;
	tui?: boolean;
}

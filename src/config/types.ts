export interface Settings {
	provider?: string;
	model?: string;
	systemPromptExtra?: string;
	maxTurns?: number;
	claimsMode?: "prose" | "tagged";
	feedback?: boolean;
}

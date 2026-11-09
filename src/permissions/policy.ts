import { normalizeRule, ruleAllows, sessionRulesFor } from "./rules.js";
import type {
	Asker,
	PermissionDecision,
	PermissionGate,
	PermissionMode,
	PermissionRequest,
	PermissionSettings,
} from "./types.js";

export function createPolicy(
	settings: PermissionSettings | undefined,
	yes: boolean,
	ask?: Asker,
	onDenied?: PolicyOptions["onDenied"],
): PermissionPolicy {
	return new PermissionPolicy({
		mode: yes ? "allow" : (settings?.mode ?? "ask"),
		allow: settings?.allow,
		ask,
		onDenied,
	});
}

export const NO_TERMINAL_REASON =
	"Ledger has no terminal to ask for permission, so the call was denied. Rerun with --yes, " +
	'or allow the tool in .ledger/settings.json under "permissions": { "allow": [...] }';

export interface PolicyOptions {
	mode: PermissionMode;
	allow?: string[];
	ask?: Asker;
	onDenied?: (request: PermissionRequest, reason: string) => void;
}

export class PermissionPolicy implements PermissionGate {
	private readonly rules: Set<string>;

	constructor(private readonly options: PolicyOptions) {
		this.rules = new Set((options.allow ?? []).map(normalizeRule));
	}

	async check(request: PermissionRequest): Promise<PermissionDecision> {
		if (this.options.mode === "allow" || ruleAllows(this.rules, request)) return { allow: true };
		if (this.options.mode === "deny") return this.deny(request, "permissions are set to deny in settings");
		if (!this.options.ask) return this.deny(request, NO_TERMINAL_REASON);

		const offered = sessionRulesFor(request);
		const answer = await this.options.ask(request, offered);
		if (answer.kind === "once") return { allow: true };
		if (answer.kind === "session") {
			for (const rule of offered) this.rules.add(rule);
			return { allow: true };
		}
		return this.deny(request, `the user denied it (${answer.reason?.trim() || "no reason given"})`);
	}

	sessionRules(): string[] {
		return [...this.rules];
	}

	private deny(request: PermissionRequest, reason: string): PermissionDecision {
		this.options.onDenied?.(request, reason);
		return { allow: false, reason };
	}
}

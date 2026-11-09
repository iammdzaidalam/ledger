import { describeRule } from "./rules.js";
import type { Asker, PermissionAnswer } from "./types.js";

export type Question = (prompt: string) => Promise<string>;

export function terminalAsker(question: Question, write: (text: string) => void): Asker {
	return async (request, sessionRules): Promise<PermissionAnswer> => {
		const scope = sessionRules.map(describeRule).join(", ");
		const lines = [
			"",
			`Ledger wants to run ${request.tool}: ${request.summary}`,
			"  y  yes, this once",
			sessionRules.length > 0
				? `  a  yes, and allow ${scope} for the rest of this session`
				: "     (this command can't be remembered: it uses substitution or redirection)",
			"  n  no, and tell the model why",
		];
		write(`${lines.join("\n")}\n`);

		const choice = (await question("allow? [y/a/n] ")).trim().toLowerCase();
		if (choice === "y" || choice === "yes") return { kind: "once" };
		if (choice === "a" || choice === "always")
			return sessionRules.length > 0 ? { kind: "session" } : { kind: "once" };
		const reason = await question("reason for the model (optional): ");
		return { kind: "deny", reason };
	};
}

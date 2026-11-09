import type { PermissionRequest } from "./types.js";

const SUBCOMMAND_TOOLS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"npx",
	"bunx",
	"go",
	"cargo",
	"git",
	"docker",
	"kubectl",
	"make",
	"pip",
	"pip3",
	"uv",
	"poetry",
	"deno",
	"gh",
]);
const RUN_SCRIPTS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PYTHONS = new Set(["python", "python3"]);
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|\d?>\s*\/dev\/null)/g;

function scanOutsideQuotes(command: string): { segments: string[]; bare: string[] } | undefined {
	const segments: string[] = [];
	const bare: string[] = [];
	let segment = "";
	let unquoted = "";
	let quote: "'" | '"' | null = null;
	const cut = () => {
		segments.push(segment.trim());
		bare.push(unquoted);
		segment = "";
		unquoted = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] ?? "";
		if (quote) {
			if (ch === "\\" && quote === '"') {
				segment += ch + (command[++i] ?? "");
				continue;
			}
			if (ch === quote) quote = null;
			segment += ch;
			continue;
		}
		if (ch === "\\") {
			segment += ch + (command[++i] ?? "");
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			segment += ch;
			continue;
		}
		const pair = command.slice(i, i + 2);
		if (pair === "&&" || pair === "||") {
			cut();
			i++;
			continue;
		}
		if (ch === ";" || ch === "|") {
			cut();
			continue;
		}
		segment += ch;
		unquoted += ch;
	}
	if (quote) return undefined;
	cut();
	return { segments, bare };
}

export function splitCommand(command: string): string[] | undefined {
	if (/\$\(|`|<\(|>\(|\n/.test(command)) return undefined;
	const scanned = scanOutsideQuotes(command);
	if (!scanned) return undefined;
	if (scanned.bare.some((s) => s.replace(HARMLESS_REDIRECTS, "").includes(">"))) return undefined;
	const segments = scanned.segments.filter((s) => s.length > 0);
	return segments.length > 0 ? segments : undefined;
}

export function commandPrefix(segment: string): string | undefined {
	const tokens = segment.trim().split(/\s+/);
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift();
	const first = tokens[0];
	if (!first) return undefined;
	const second = tokens[1];
	if (PYTHONS.has(first) && second === "-m" && tokens[2]) return `${first} -m ${tokens[2]}`;
	if (!SUBCOMMAND_TOOLS.has(first) || !second || second.startsWith("-")) return first;
	const third = tokens[2];
	if (RUN_SCRIPTS.has(first) && second === "run" && third && !third.startsWith("-")) {
		return `${first} run ${third}`;
	}
	return `${first} ${second}`;
}

export function bashPrefixes(command: string): string[] | undefined {
	const segments = splitCommand(command);
	if (!segments) return undefined;
	const prefixes = segments.map(commandPrefix);
	if (prefixes.some((p) => p === undefined)) return undefined;
	return [...new Set(prefixes as string[])];
}

export function sessionRulesFor(request: PermissionRequest): string[] {
	if (request.tool !== "Bash") return [request.tool];
	const prefixes = bashPrefixes(String(request.input.command ?? ""));
	return prefixes ? prefixes.map((p) => `Bash(${p})`) : [];
}

export function ruleAllows(rules: ReadonlySet<string>, request: PermissionRequest): boolean {
	if (rules.has(request.tool)) return true;
	if (request.tool !== "Bash") return false;
	const prefixes = bashPrefixes(String(request.input.command ?? ""));
	return prefixes?.every((p) => rules.has(`Bash(${p})`)) === true;
}

export function normalizeRule(rule: string): string {
	const match = /^(\w+)\((.*)\)$/.exec(rule.trim());
	if (!match) return rule.trim();
	return `${match[1]}(${(match[2] ?? "").trim().split(/\s+/).join(" ")})`;
}

export function describeRule(rule: string): string {
	const match = /^Bash\((.*)\)$/.exec(rule);
	return match ? `\`${match[1]}\` commands` : `${rule} calls`;
}

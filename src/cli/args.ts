export interface ParsedArgs {
	message?: string;
	provider?: string;
	model?: string;
	print: boolean;
	help: boolean;
	version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = { print: false, help: false, version: false };
	const rest: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--provider") {
			result.provider = argv[++i];
		} else if (arg === "--model") {
			result.model = argv[++i];
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else {
			rest.push(arg!);
		}
	}

	if (rest.length > 0) result.message = rest.join(" ");
	return result;
}

export const HELP_TEXT = `ledger [message]            Interactive REPL (default)
ledger --print [message]    One-shot: stream the answer to stdout
echo "..." | ledger -p      Read the prompt from a pipe

Options
  --provider <name>   claude (default), gemini, or groq
  --model <id>        Specific model id
  --print, -p         Non-interactive output
  --version, -v
  --help, -h
`;

export interface ParsedArgs {
	message?: string;
	provider?: string;
	model?: string;
	session?: string;
	resume?: string;
	claims?: string;
	validate?: string;
	maxRevisions?: string;
	continue: boolean;
	listSessions: boolean;
	yes: boolean;
	feedback: boolean;
	print: boolean;
	noTui: boolean;
	help: boolean;
	version: boolean;
}

const VALUE_FLAGS: Record<
	string,
	"provider" | "model" | "session" | "resume" | "claims" | "validate" | "maxRevisions"
> = {
	"--provider": "provider",
	"--model": "model",
	"--session": "session",
	"--resume": "resume",
	"-r": "resume",
	"--claims": "claims",
	"--validate": "validate",
	"--max-revisions": "maxRevisions",
};

const BOOLEAN_FLAGS: Record<
	string,
	"continue" | "listSessions" | "yes" | "feedback" | "print" | "noTui" | "help" | "version"
> = {
	"--continue": "continue",
	"-c": "continue",
	"--list-sessions": "listSessions",
	"--yes": "yes",
	"-y": "yes",
	"--feedback": "feedback",
	"--print": "print",
	"-p": "print",
	"--no-tui": "noTui",
	"--help": "help",
	"-h": "help",
	"--version": "version",
	"-v": "version",
};

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		continue: false,
		listSessions: false,
		yes: false,
		feedback: false,
		print: false,
		noTui: false,
		help: false,
		version: false,
	};
	const rest: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const valueKey = VALUE_FLAGS[arg];
		const booleanKey = BOOLEAN_FLAGS[arg];
		if (valueKey) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a value`);
			result[valueKey] = value;
		} else if (booleanKey) {
			result[booleanKey] = true;
		} else {
			rest.push(arg);
		}
	}

	if (rest.length === 1 && rest[0] === "sessions") {
		result.listSessions = true;
		return result;
	}
	if (rest.length > 0) result.message = rest.join(" ");
	return result;
}

export const HELP_TEXT = `ledger [message]            Interactive terminal UI (default)
ledger --print [message]    One-shot: stream the answer to stdout
echo "..." | ledger -p      Read the prompt from a pipe
ledger sessions             List saved sessions in this directory

Options
  --provider <name>   claude (default), gemini, groq, or ollama
  --model <id>        Specific model id (any local tag for ollama)
  --session <id>      Session id, written to .ledger/sessions/<id>.jsonl;
                      an existing id is resumed
  --resume, -r <id>   Resume a saved session (an id prefix is enough)
  --continue, -c      Resume the most recent session
  --list-sessions     Same as \`ledger sessions\`
  --yes, -y           Approve every tool call without asking
  --claims <mode>     prose (default) or tagged: ask the model to wrap
                      claims as <claim ref="c3">...</claim>
  --validate <mode>   off, flag (default), revise, or strict:
                      flag shows false claims, revise sends them back
                      for the model to correct, strict also exits 2 in
                      print mode if any are still false at the end
  --max-revisions <n> Revisions allowed per flagged turn (default 1)
  --feedback          Same as --validate revise
  --print, -p         Non-interactive output
  --no-tui            Use the plain line-by-line REPL instead of the
                      full-screen UI (also "tui": false in settings)
  --version, -v
  --help, -h

In the UI or the REPL, /help lists the slash commands.
`;

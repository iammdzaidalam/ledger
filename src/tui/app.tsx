import { Box, type Key, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { BUILTIN_COMMANDS } from "../commands/builtin.js";
import { parseCommandLine, type ReplState, runCommandLine, type SlashCommand } from "../commands/registry.js";
import type { GroundingClient } from "../grounding/client.js";
import type { TurnSettings } from "../modes/turn.js";
import { runTurn } from "../modes/turn.js";
import { readableError } from "../providers/errors.js";
import { type Editor, EMPTY_EDITOR, editKey, insertText, moveVertical, setText } from "./editor.js";
import { InputBox, inputLines } from "./input.js";
import { hintLines, transcriptLines } from "./layout.js";
import { ColorContext } from "./lines.js";
import { Panel } from "./panel.js";
import { answerFor, choiceForKey, type PermissionQueue, scopeText } from "./permission.js";
import { PermissionPrompt, permissionLines } from "./permission-prompt.js";
import { initialState, reduce, type TuiAction } from "./state.js";
import { StatusBar } from "./status-bar.js";
import type { Line } from "./text.js";
import { Transcript, viewport } from "./transcript.js";

export type RunTurn = typeof runTurn;

export interface LogSink {
	attach(handler: (text: string) => void): () => void;
}

export interface AppProps {
	repl: ReplState;
	turn: TurnSettings;
	groundingClient: GroundingClient;
	permissions: PermissionQueue;
	initialMessage?: string;
	resumed: boolean;
	color: boolean;
	commands?: readonly SlashCommand[];
	run?: RunTurn;
	logs?: LogSink;
	size?: { columns: number; rows: number };
}

const MAX_HINTS = 6;
const PLACEHOLDER = "Ask for a change, or type / for commands. Ctrl+J adds a line.";

function syncAction(repl: ReplState): TuiAction {
	const s = repl.session;
	return {
		type: "sync",
		session: { id: s.id, provider: s.providerName, model: s.model },
		evidence: s.evidence.all(),
		claims: s.claims,
	};
}

function bannerText(repl: ReplState, resumed: boolean): string {
	const s = repl.session;
	const lines = [`ledger ${s.providerName}/${s.model}, session ${s.id}`];
	if (resumed) {
		lines.push(
			`Resumed with ${s.history.length} messages in context and ${s.evidence.all().length} evidence entries.`,
		);
	}
	lines.push("Enter sends, Ctrl+J adds a line, Ctrl+O toggles the evidence panel, PgUp/PgDn scroll.");
	lines.push("Ctrl+C cancels a run, or quits when idle. /help lists the commands.");
	return lines.join("\n");
}

function matchingCommands(commands: readonly SlashCommand[], text: string): SlashCommand[] {
	if (!text.startsWith("/") || /\s/.test(text)) return [];
	const typed = text.slice(1).toLowerCase();
	return commands
		.filter((c) => c.name.startsWith(typed) || c.aliases?.some((a) => a.startsWith(typed)))
		.slice(0, MAX_HINTS);
}

export function App(props: AppProps) {
	const commands = props.commands ?? BUILTIN_COMMANDS;
	const run = props.run ?? runTurn;
	const { exit } = useApp();
	const windowSize = useWindowSize();
	const { columns, rows } = props.size ?? windowSize;

	const [state, dispatch] = useReducer(
		reduce,
		undefined,
		(): ReturnType<typeof initialState> =>
			initialState({
				session: {
					id: props.repl.session.id,
					provider: props.repl.session.providerName,
					model: props.repl.session.model,
				},
				validate: props.turn.validate,
				evidence: props.repl.session.evidence.all(),
				claims: props.repl.session.claims,
			}),
	);
	const [editor, setEditor] = useState<Editor>(EMPTY_EDITOR);
	const [reason, setReason] = useState<Editor | null>(null);
	const [panelOpen, setPanelOpen] = useState(columns >= 120);
	const [top, setTop] = useState<number | null>(null);
	const [hintIndex, setHintIndex] = useState(0);
	const [hintsDismissed, setHintsDismissed] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const history = useRef<string[]>([]);
	const historyAt = useRef<number | null>(null);
	const draft = useRef("");
	const abort = useRef<AbortController | null>(null);
	const startedAt = useRef(0);
	const cache = useRef({ width: 0, map: new WeakMap() });

	const pending = useSyncExternalStore(props.permissions.subscribe, props.permissions.current);

	useEffect(() => {
		if (!state.running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [state.running]);

	useEffect(
		() => props.logs?.attach((text) => dispatch({ type: "notice", tone: "warn", text })),
		[props.logs],
	);

	const quit = useCallback(() => {
		abort.current?.abort();
		props.permissions.denyAll("the user quit Ledger");
		exit();
	}, [exit, props.permissions]);

	const execute = useCallback(
		async (text: string) => {
			if (parseCommandLine(text)) {
				dispatch({ type: "command", text });
				setBusy(text.split(/\s+/)[0] ?? text);
				const result = await runCommandLine(text, {
					state: props.repl,
					commands,
					print: (out) => dispatch({ type: "output", text: out }),
				});
				setBusy(null);
				dispatch(syncAction(props.repl));
				if (result.exit) quit();
				return;
			}
			dispatch({ type: "submit", text });
			const controller = new AbortController();
			abort.current = controller;
			startedAt.current = Date.now();
			setNow(Date.now());
			try {
				await run(
					props.repl.session,
					text,
					props.turn,
					props.groundingClient,
					(event) => dispatch({ type: "agent", event }),
					controller.signal,
				);
				dispatch({ type: "run_finished", cancelled: controller.signal.aborted });
			} catch (err) {
				const cancelled = controller.signal.aborted;
				dispatch({ type: "run_finished", cancelled, error: cancelled ? undefined : readableError(err) });
			} finally {
				abort.current = null;
				dispatch(syncAction(props.repl));
			}
		},
		[commands, props.repl, props.turn, props.groundingClient, run, quit],
	);

	const submit = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (!text || state.running || busy) return;
			if (history.current.at(-1) !== text) history.current.push(text);
			historyAt.current = null;
			setEditor(EMPTY_EDITOR);
			setTop(null);
			setHintsDismissed(false);
			setHintIndex(0);
			void execute(text);
		},
		[state.running, busy, execute],
	);

	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		dispatch({ type: "notice", tone: "info", text: bannerText(props.repl, props.resumed) });
		if (props.initialMessage?.trim()) submit(props.initialMessage);
	}, [props.repl, props.resumed, props.initialMessage, submit]);

	const panelSide = panelOpen && columns >= 90;
	const panelOnly = panelOpen && !panelSide;
	const panelWidth = panelSide ? Math.max(32, Math.min(60, Math.round(columns * 0.36))) : 0;
	const mainWidth = Math.max(10, columns - panelWidth);
	const textWidth = Math.max(8, mainWidth - 2);

	if (cache.current.width !== textWidth) cache.current = { width: textWidth, map: new WeakMap() };
	const allLines = useMemo(
		() => transcriptLines(state.entries, textWidth, cache.current.map),
		[state.entries, textWidth],
	);

	const hints = !pending && !hintsDismissed ? matchingCommands(commands, editor.text) : [];
	const selected = Math.min(hintIndex, Math.max(0, hints.length - 1));
	const hintView: Line[] = hints.length > 0 ? hintLines(hints, selected, columns - 2) : [];
	const promptView = pending ? permissionLines(pending, reason, columns - 2) : null;
	const inputView = inputLines(editor, columns - 1, !pending, state.running ? "" : PLACEHOLDER);
	const bottomHeight = 1 + (promptView ? promptView.length + 1 : inputView.length + hintView.length + 1);
	const mainHeight = Math.max(3, rows - bottomHeight);
	const view = viewport(allLines, mainHeight, top);
	const page = Math.max(1, mainHeight - 2);

	const scrollBy = (delta: number) => {
		const max = Math.max(0, allLines.length - mainHeight);
		const current = top ?? max;
		const next = Math.max(0, Math.min(max, current + delta));
		setTop(next >= max ? null : next);
	};

	const historyStep = (dir: -1 | 1) => {
		const list = history.current;
		if (list.length === 0) return;
		if (historyAt.current === null) {
			if (dir === 1) return;
			draft.current = editor.text;
			historyAt.current = list.length - 1;
		} else {
			const next = historyAt.current + dir;
			if (next >= list.length) {
				historyAt.current = null;
				setEditor(setText(draft.current));
				return;
			}
			historyAt.current = Math.max(0, next);
		}
		setEditor(setText(list[historyAt.current] ?? ""));
	};

	const onPermissionKey = (input: string, key: Key) => {
		if (!pending) return;
		if (reason) {
			if (key.escape) {
				setReason(null);
				props.permissions.answer({ kind: "deny" });
				return;
			}
			const next = editKey(reason, input, key);
			if (next === "submit") {
				setReason(null);
				props.permissions.answer({ kind: "deny", reason: reason.text });
			} else if (next) setReason(next);
			return;
		}
		if (key.escape) {
			props.permissions.answer({ kind: "deny" });
			return;
		}
		const choice = choiceForKey(input);
		if (choice === "deny") setReason(EMPTY_EDITOR);
		else if (choice) {
			const answer = answerFor(choice, pending.rules);
			if (answer.kind === "session") {
				dispatch({
					type: "notice",
					tone: "info",
					text: `Allowed ${scopeText(pending.rules)} for this session.`,
				});
			}
			props.permissions.answer(answer);
		}
	};

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			if (pending || state.running) {
				setReason(null);
				props.permissions.denyAll("the user cancelled the run");
				abort.current?.abort();
				return;
			}
			if (editor.text) {
				setEditor(EMPTY_EDITOR);
				return;
			}
			quit();
			return;
		}
		if (key.ctrl && input === "o") {
			setPanelOpen((open) => !open);
			return;
		}
		if (key.pageUp || (key.ctrl && input === "b")) return scrollBy(-page);
		if (key.pageDown || (key.ctrl && input === "f")) return scrollBy(page);
		if (key.shift && key.upArrow) return scrollBy(-3);
		if (key.shift && key.downArrow) return scrollBy(3);
		if (pending) return onPermissionKey(input, key);
		if (key.ctrl && input === "d" && !editor.text && !state.running) return quit();

		if (hints.length > 0) {
			if (key.upArrow) return setHintIndex((selected - 1 + hints.length) % hints.length);
			if (key.downArrow) return setHintIndex((selected + 1) % hints.length);
			if (key.escape) return setHintsDismissed(true);
			const chosen = hints[selected];
			if (key.tab && chosen) {
				setEditor(setText(`/${chosen.name}${chosen.usage ? " " : ""}`));
				return;
			}
			if (key.return && !key.meta && chosen) {
				const exact = hints.some(
					(c) => `/${c.name}` === editor.text || c.aliases?.some((a) => `/${a}` === editor.text),
				);
				return submit(exact ? editor.text : `/${chosen.name}`);
			}
		}
		if (key.escape) {
			setTop(null);
			return;
		}
		if (key.upArrow || key.downArrow) {
			const dir = key.upArrow ? -1 : 1;
			const moved = moveVertical(editor, dir);
			if (moved) setEditor(moved);
			else historyStep(dir);
			return;
		}
		const next = editKey(editor, input, key);
		if (next === "submit") submit(editor.text);
		else if (next) {
			setEditor(next);
			if (next.text !== editor.text) {
				setHintsDismissed(false);
				setHintIndex(0);
			}
		}
	});

	usePaste((text) => {
		if (pending && reason) setReason(insertText(reason, text.replace(/\n/g, " ")));
		else if (!pending) setEditor((e) => insertText(e, text));
	});

	const seconds = Math.max(0, Math.round((now - startedAt.current) / 1000));
	const activity = busy
		? `running ${busy}`
		: pending
			? "waiting for your answer"
			: state.running
				? `working ${seconds}s, Ctrl+C cancels`
				: undefined;

	return (
		<ColorContext.Provider value={props.color}>
			<Box flexDirection="column" width={columns} height={rows}>
				<Box flexDirection="row" height={mainHeight}>
					{panelOnly ? null : <Transcript view={view} width={mainWidth} height={mainHeight} />}
					{panelOpen ? (
						<Panel state={state} width={panelOnly ? columns : panelWidth} height={mainHeight} />
					) : null}
				</Box>
				{promptView ? (
					<PermissionPrompt lines={promptView} width={columns} />
				) : (
					<InputBox lines={inputView} hints={hintView} width={columns} />
				)}
				<StatusBar
					width={columns}
					info={{
						provider: state.session.provider,
						model: state.session.model,
						session: state.session.id,
						validate: state.validate,
						evidence: state.evidence.length,
						claims: state.claims,
						activity,
						scrolled: view.below > 0 ? view.below : undefined,
					}}
				/>
			</Box>
		</ColorContext.Provider>
	);
}

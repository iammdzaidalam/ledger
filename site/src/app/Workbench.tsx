import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import sourceJson from "../data/source.json";
import { Canvas } from "./Canvas";
import type { AppName } from "./route";
import type { AppStep, Badge, Graph } from "./types";

interface Snippet {
	file: string;
	line: number;
	lines: string[];
}

const sources = sourceJson as Record<string, Snippet>;
const SPEEDS = [0.5, 1, 2];

type Tab = "payload" | "messages" | "events";

export function Workbench({
	app,
	onApp,
	path,
	controls,
	status,
	graph,
	steps,
	step,
	onStep,
	drawer,
	graphLabel,
}: {
	app: AppName;
	onApp: (a: AppName) => void;
	path: string;
	controls: ReactNode;
	status: ReactNode;
	graph: Graph;
	steps: AppStep[];
	step: number;
	onStep: (n: number) => void;
	drawer?: ReactNode;
	graphLabel: string;
}) {
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [tab, setTab] = useState<Tab>("payload");
	const total = steps.length;
	const index = Math.min(step, total - 1);
	const current = steps[index];
	const stepRef = useRef({ index, total });
	stepRef.current = { index, total };

	useEffect(() => {
		setPlaying(false);
	}, [steps]);

	useEffect(() => {
		if (!playing) return;
		if (index >= total - 1) {
			setPlaying(false);
			return;
		}
		const t = window.setTimeout(() => onStep(index + 1), 1700 / speed);
		return () => window.clearTimeout(t);
	}, [playing, index, total, speed, onStep]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const { index: i, total: n } = stepRef.current;
			if (e.key === "ArrowRight") {
				e.preventDefault();
				setPlaying(false);
				onStep(Math.min(n - 1, i + 1));
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				setPlaying(false);
				onStep(Math.max(0, i - 1));
			} else if (e.key === " " && el?.tagName !== "BUTTON") {
				e.preventDefault();
				setPlaying((p) => !p);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onStep]);

	const { visited, badges } = useMemo(() => {
		const v = new Set<string>();
		const b: Record<string, Badge> = {};
		for (let i = 0; i <= index; i++) {
			for (const n of steps[i].nodes) v.add(n);
			Object.assign(b, steps[i].badges);
		}
		return { visited: v, badges: b };
	}, [steps, index]);

	const snippet = current.src ? sources[current.src] : null;
	const payload = useMemo(() => {
		const p = current.payload;
		if (Array.isArray(p)) return p.length === 0 ? "[]" : `[\n${p.map((x) => `  ${JSON.stringify(x)}`).join(",\n")}\n]`;
		return JSON.stringify(p, null, 2);
	}, [current]);

	return (
		<div className="wb hero-text">
			<header className="wb__top">
				<div className="wb__row">
					<div className="wb__id">
					<h1 className="wb__brand">
						<a href="index.html">
							<svg className="wb__mark" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M2.5 21.5V12a9.5 9.5 0 0 1 19 0v9.5h-6V12a3.5 3.5 0 0 0-7 0v9.5z" />
							</svg>
							Ledger<span className="wb__long"> {app} playground</span>
						</a>
					</h1>
					<a className="wb__back" href="index.html">
						Back to site
					</a>
					</div>
					<p className="wb__path">{total} steps: {path}</p>
					<div className="wb__seg" role="group" aria-label="App">
						<button type="button" aria-pressed={app === "checker"} onClick={() => onApp("checker")}>
							Checker
						</button>
						<button type="button" aria-pressed={app === "swarm"} onClick={() => onApp("swarm")}>
							Swarm
						</button>
					</div>
				</div>
				<div className="wb__row wb__row--controls">
					{controls}
					<div className="wb__status">{status}</div>
				</div>
			</header>

			<div className="wb__main ui ui-workbench">
				<div className="wb__canvas">
					<Canvas
						graph={graph}
						activeNodes={new Set(current.nodes)}
						activeEdges={new Set(current.edges)}
						visited={visited}
						badges={badges}
						playing={playing}
						label={graphLabel}
					/>
				</div>
				<aside className="wb__panel" aria-label="Step details">
					<div className="wb__head">
						<p className="wb__count">
							<b>
								{index + 1} / {total}
							</b>
							<span>{current.phase}</span>
						</p>
						<p className="wb__title" aria-live="polite">{current.title}</p>
						{snippet ? (
							<p className="wb__ref">
								{snippet.file}:{snippet.line}
							</p>
						) : null}
						<p className="wb__desc">{current.desc}</p>
					</div>
					<div className="wb__insp">
						<div className="wb__tabs" role="tablist" aria-label="Inspector">
							{(["payload", "messages", "events"] as Tab[]).map((t) => (
								<button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
									{t}
								</button>
							))}
						</div>
						<div className="wb__tabbody" role="tabpanel">
							{tab === "payload" ? <pre className="wb__json">{payload}</pre> : null}
							{tab === "messages" ? (
								current.messages.length ? (
									<ul className="wb__msgs">
										{current.messages.map((m, i) => (
											<li key={`${m.label}-${i}`}>
												<span>{m.label}</span>
												<p>{m.text}</p>
											</li>
										))}
									</ul>
								) : (
									<p className="wb__none">No message at this step.</p>
								)
							) : null}
							{tab === "events" ? (
								current.events.length ? (
									<ul className="wb__events">
										{current.events.map((e, i) => (
											<li key={`${e.type}-${i}`}>
												<b>{e.type}</b>
												<span>{e.text}</span>
											</li>
										))}
									</ul>
								) : (
									<p className="wb__none">No event at this step.</p>
								)
							) : null}
						</div>
					</div>
					{snippet ? (
						<div className="wb__src">
							<p className="wb__label">Source</p>
							<pre>
								{snippet.lines.map((l, i) => (
									<span key={i}>
										<i>{snippet.line + i}</i>
										{l}
										{"\n"}
									</span>
								))}
							</pre>
						</div>
					) : (
						<div className="wb__src wb__src--none">
							<p className="wb__label">Source</p>
							<p className="wb__none">This step is data moving, there is no code of its own.</p>
						</div>
					)}
				</aside>
				{drawer}
			</div>

			<footer className="wb__bar">
				<div className="wb__ctl">
					<button type="button" onClick={() => { setPlaying(false); onStep(0); }} aria-label="Reset to the first step">
						<svg viewBox="0 0 12 12" aria-hidden="true">
							<path d="M2.5 6a3.5 3.5 0 1 0 1.2-2.6M2.5 1.8v2.2H4.7" />
						</svg>
					</button>
					<button type="button" onClick={() => { setPlaying(false); onStep(Math.max(0, index - 1)); }} disabled={index === 0} aria-label="Previous step">
						<svg viewBox="0 0 12 12" aria-hidden="true">
							<path d="M7.5 2.5 4 6l3.5 3.5" />
						</svg>
					</button>
					<button
						type="button"
						className="wb__play"
						onClick={() => {
							if (index >= total - 1) onStep(0);
							setPlaying((p) => !p);
						}}
						aria-label={playing ? "Pause" : "Play"}
					>
						<svg viewBox="0 0 12 12" aria-hidden="true">
							{playing ? <path d="M3.5 2v8M8.5 2v8" /> : <path className="wb__fill" d="M3 1.8v8.4L10 6z" />}
						</svg>
						{playing ? "Pause" : "Play"}
					</button>
					<button type="button" onClick={() => { setPlaying(false); onStep(Math.min(total - 1, index + 1)); }} disabled={index >= total - 1} aria-label="Next step">
						<svg viewBox="0 0 12 12" aria-hidden="true">
							<path d="M4.5 2.5 8 6 4.5 9.5" />
						</svg>
					</button>
				</div>
				<div className="wb__speed" role="group" aria-label="Speed">
					{SPEEDS.map((s) => (
						<button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
							{s}x
						</button>
					))}
				</div>
				<ol className="wb__line" aria-label="Steps">
					{steps.map((s, i) => (
						<li key={i}>
							<button
								type="button"
								className={i < index ? "is-past" : i === index ? "is-now" : ""}
								aria-label={`Step ${i + 1}: ${s.title}`}
								aria-current={i === index ? "step" : undefined}
								title={`${i + 1}. ${s.title}`}
								onClick={() => { setPlaying(false); onStep(i); }}
							/>
						</li>
					))}
				</ol>
				<p className="wb__phase">{current.phase}</p>
				<p className="wb__keys">
					<kbd>←</kbd> <kbd>→</kbd> step <kbd>space</kbd> play
				</p>
			</footer>
		</div>
	);
}

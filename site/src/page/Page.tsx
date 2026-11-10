import type { ReactNode } from "react";
import artJson from "../data/art.json";
import evalJson from "../data/eval.json";
import fleetJson from "../data/fleet.json";
import type { EvalData, FleetData } from "../types";
import type { Initial } from "../lib/sandbox";
import { HeroDemo } from "./HeroDemo";
import { ReplayApp } from "./ReplayApp";

const data = evalJson as EvalData;
const fleet = fleetJson as FleetData;
const ART = "./art/";
const ICONS = "./assets/icons/";
const GH = "https://github.com/iammdzaidalam/ledger";

interface Piece {
	width: number;
	height: number;
	files: { webp: { file: string; width: number }[]; jpg: string };
}
const pieces = artJson.pieces as Record<string, Piece>;

function Photo({ piece, alt, className, sizes, subject }: { piece: string; alt: string; className?: string; sizes: string; subject: string }) {
	const p = pieces[piece];
	return (
		<picture className={className}>
			<source type="image/webp" srcSet={p.files.webp.map((f) => `${ART}${f.file} ${f.width}w`).join(", ")} sizes={sizes} />
			<img
				className="frame__img"
				src={`${ART}${p.files.jpg}`}
				width={p.width}
				height={p.height}
				alt={alt}
				loading="lazy"
				decoding="async"
				data-source="library"
				data-subject={subject}
			/>
		</picture>
	);
}

const Arrow = () => (
	<svg className="m-arrow" viewBox="0 0 12 12" aria-hidden="true">
		<path className="m-arrow__stem" d="M1 6h8" />
		<path className="m-arrow__head" d="M4.5 2.5 8 6l-3.5 3.5" />
	</svg>
);

const SECTIONS = [
	{ id: "checker", label: "How it works" },
	{ id: "replay", label: "Replay" },
	{ id: "results", label: "Results" },
	{ id: "fleet", label: "Fleet" },
	{ id: "install", label: "Install" },
];

const NAV = [{ href: "playground.html", label: "Playground" }, ...SECTIONS.map((x) => ({ href: `#${x.id}`, label: x.label }))];

const STEPS = [
	{ n: "1", title: "Split", text: "The turn's text becomes claims. Plans, hedges and questions are skipped." },
	{ n: "2", title: "Match", text: "A claim tag wins, then a command or path the sentence names, then the latest run of that kind." },
	{ n: "3", title: "Judge", text: "A rule reads the exit code, test summary or diff. A pass older than the last edit counts for nothing." },
];

const RULES = [
	{ rule: "tests_pass", flagged: "The latest test run failed, ran no tests, is stale, or never ran." },
	{ rule: "lint_clean", flagged: "The latest linter run failed or listed problems, or never ran." },
	{ rule: "file_created", flagged: "The write failed, or nothing wrote that path." },
	{ rule: "bug_fixed", flagged: "No file changed, or nothing passed after the last change." },
	{ rule: "command_success", flagged: "The command it points at exited non-zero." },
	{ rule: "not_executed", flagged: "The command never started or timed out." },
];

const GATE = [
	{ verdict: "PASS", what: "The attempt merges into the integration branch, one at a time." },
	{ verdict: "RETRY", what: "It runs again, with the flagged claims in its prompt." },
	{ verdict: "BLOCK", what: "Still flagged on the last attempt, so nothing merges." },
	{ verdict: "FAIL", what: "A worker error, or no file changed after the retry." },
];

const LANES = [1, 2, 3];

const SERVICE = ["Postgres queue", "Connect/gRPC", "Redis events", "OpenTelemetry", "Prometheus"];

const PROVIDERS = [
	{ id: "claude", flag: "claude", models: "claude-sonnet-4-5, claude-opus-4-1 (default)", w: 40, h: 40, cls: "" },
	{ id: "gemini", flag: "gemini", models: "gemini-2.5-pro, gemini-2.5-flash", w: 40, h: 40, cls: "" },
	{ id: "groq", flag: "groq", models: "llama-3.3-70b-versatile, llama-3.1-8b-instant", w: 40, h: 11, cls: " ic-wide" },
	{ id: "ollama", flag: "ollama", models: "any local tag, e.g. qwen2.5:7b, llama3.1:8b", w: 30, h: 40, cls: " ic-tall ic-ink" },
];

const INSTALL = [
	"git clone https://github.com/iammdzaidalam/ledger",
	"cd ledger && npm install",
	"npm run build && npm link",
	'ledger --provider ollama --model qwen2.5:7b "run the tests"',
];

export interface PageHtml {
	hero?: string;
	replay?: string;
	initial?: Initial;
}

function Island({ id, html, className, children }: { id: string; html?: string; className?: string; children: ReactNode }) {
	if (html !== undefined) return <div id={id} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
	return (
		<div id={id} className={className}>
			{children}
		</div>
	);
}

function Nav() {
	return (
		<header className="nav nav--centre">
			<div className="wrap nav__bar">
				<a className="skip-link" href="#top">
					Skip to content
				</a>
				<a className="nav__logo" href="#top">
					<span className="mark" data-mark="arc" aria-hidden="true" />
					Ledger
				</a>
				<nav className="nav__links" aria-label="Main">
					{NAV.map((n) => (
						<div className="nav__item" key={n.label}>
							<a className="nav__link" href={n.href}>
								{n.label}
							</a>
						</div>
					))}
				</nav>
				<div className="nav__actions">
					<a className="btn btn--primary" href="#install">
						Get Ledger
					</a>
				</div>
				<button className="nav__toggle" type="button" aria-expanded="false" aria-label="Menu">
					<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
						<path d="M2 5h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					</svg>
				</button>
			</div>
		</header>
	);
}

function Hero({ html }: { html: PageHtml }) {
	return (
		<section className="hero hero--split" data-enter aria-labelledby="hero-h">
			<div className="wrap">
				<div className="hero-text grid hero__grid">
					<div className="hero__text span-5">
						<h1 id="hero-h">Coding agent that checks its claims</h1>
						<p className="hero__lead">
							<span className="lead-long">
								Ledger runs in your terminal and records every Bash, Write and Edit call. After each turn a Go checker compares what the
								model said with that record and flags what it contradicts, in {data.latencyP50Ms} ms at the median.
							</span>
							<span className="lead-short">
								A Go checker flags every claim the tool record contradicts, in {data.latencyP50Ms} ms at the median.
							</span>
						</p>
						<div className="btn-row">
							<a className="btn btn--primary" href="playground.html">
								Open the playground
								<Arrow />
							</a>
							<a className="btn btn--secondary" href="#install">
								Get Ledger
							</a>
						</div>
					</div>
					<div className="hero__media span-6 start-7">
						<Photo piece="syndics" alt="" sizes="(max-width: 639px) 560px, 2000px" subject="Rembrandt, The Syndics of the Drapers' Guild" className="hero__ground" />
						<Island id="hero-island" html={html.hero} className="hero__demo">
							<HeroDemo initial={html.initial ?? {}} />
						</Island>
					</div>
				</div>
			</div>
		</section>
	);
}

function Checker() {
	return (
		<section className="section g2m" id="checker" aria-labelledby="checker-h">
			<div className="wrap">
				<div className="grid">
					<div className="span-5 stack-6">
						<h2 id="checker-h">How a claim gets checked</h2>
						<p className="t-lead">
							When a turn ends, the checker gets its text and the whole evidence log. It never calls a model, so the same input
							always gives the same verdict.
						</p>
						<ol className="steps">
							{STEPS.map((s) => (
								<li key={s.n}>
									<span className="steps__n">{s.n}</span>
									<span>
										<b>{s.title}</b> {s.text}
									</span>
								</li>
							))}
						</ol>
						<div className="btn-row">
							<a className="btn btn--secondary" href="playground.html#checker/write-failed/on/0">
								Open the checker app
							</a>
							<a className="link" href={`${GH}/blob/main/docs/design/verify-after-the-turn.md`}>
								Read the design doc
							</a>
						</div>
					</div>
					<div className="sheet ui ui-rules span-6 start-7">
						<p className="sheet__head">The six rules</p>
						<ul className="rules" aria-label="The rules, one per kind of claim">
							{RULES.map((r) => (
								<li key={r.rule}>
									<span className="rules__name">{r.rule}</span>
									<span className="rules__text">{r.flagged}</span>
								</li>
							))}
						</ul>
					</div>
				</div>
			</div>
		</section>
	);
}

function ReplaySection({ html }: { html: PageHtml }) {
	return (
		<section className="section ground-inverse" id="replay" aria-labelledby="replay-h" style={{ ["--h" as string]: 1, ["--hm" as string]: 2 }}>
			<div className="wrap">
				<div className="grid">
					<h2 id="replay-h" className="span-5">
						Recorded sessions, step by step
					</h2>
					<div className="span-6 start-7 stack-4">
						<p>
							Real traces from the eval on local models. Step through each tool call, its exit code, the reply and the verdict the
							checker stamped on it.
						</p>
						<a className="link" href={`${GH}/tree/main/eval/traces/run1`}>
							Read the trace files
						</a>
					</div>
				</div>
				<Island id="replay-island" html={html.replay} className="fill rp-host">
					<ReplayApp />
				</Island>
			</div>
		</section>
	);
}

const BARS = [
	{ metric: "Precision", note: "Of the turns it flagged, how many really had a false claim", a: data.scale.precision, b: data.scale.judgePrecision },
	{ metric: "Recall", note: "Of the turns with a false claim, how many it flagged", a: data.scale.recall, b: data.scale.judgeRecall },
];

function Results() {
	const missed = data.heldOut.positives - data.heldOut.tp;
	return (
		<section className="section" id="results" aria-labelledby="results-h" style={{ ["--hm" as string]: 2 }}>
			<div className="wrap">
				<div data-moment="liquid-type" className="section-head statement-head">
					<h2 id="results-h" className="mo-lt__type">
						Tested on {data.scale.turns.toLocaleString("en-US")} real turns
					</h2>
				</div>
				<div className="grid">
					<div className="span-5 stack-5">
						<p className="t-lead">
							A frontier model fixing GitHub issues, {data.scale.sessions} sessions. The checker misses most false claims. A
							local LLM judge catches them all and is wrong almost every time it speaks.
						</p>
						<ul className="facts">
							<li>
								{data.latencyP50Ms} ms per turn at the median, {data.latencyP95Ms} ms at p95, no model calls. The judge took {data.judge.p50Ms} ms.
							</li>
							<li>
								In fresh scenarios {data.heldOut.tp} of its {data.heldOut.flagged} flags were right, and it missed {missed} of {data.heldOut.positives} false turns.
							</li>
							<li>Labels by two blind Claude passes. No person has checked them yet.</li>
						</ul>
						<a className="link" href={`${GH}/blob/main/eval/results/openhands.md`}>
							Read the full results
						</a>
					</div>
					<div className="results-frame span-6 start-7">
						<Photo
							piece="moneylender"
							className="results-frame__ground"
							alt="Detail of Quentin Matsys's Moneylender and His Wife: a man weighing coins on a small balance"
							sizes="(max-width: 1023px) 100vw, 628px"
							subject="Quentin Matsys, The Moneylender and His Wife"
						/>
						<figure className="chart ui ui-chart" aria-label={`Checker against an LLM judge on ${data.scale.turns} real turns. Precision ${data.scale.precision}% against ${data.scale.judgePrecision}%. Recall ${data.scale.recall}% against ${data.scale.judgeRecall}%.`}>
							{BARS.map((b) => (
								<div className="chart__group" key={b.metric}>
									<div className="chart__head">
										<p className="chart__title">{b.metric}</p>
										<p>{b.note}</p>
									</div>
									<div className="chart__row chart__row--a">
										<span>Checker</span>
										<span className="chart__track">
											<i style={{ width: `${b.a}%` }} />
										</span>
										<b>{b.a}%</b>
									</div>
									<div className="chart__row chart__row--b">
										<span>LLM judge</span>
										<span className="chart__track">
											<i style={{ width: `${b.b}%` }} />
										</span>
										<b>{b.b}%</b>
									</div>
								</div>
							))}
						</figure>
					</div>
				</div>
			</div>
		</section>
	);
}

function Fleet() {
	return (
		<section className="section g2m" id="fleet" aria-labelledby="fleet-h">
			<div className="wrap">
				<div className="grid">
					<div className="span-5 stack-6">
						<h2 id="fleet-h">Ledger Fleet, parallel agents behind the gate</h2>
						<p className="t-lead">
							<span className="mono">ledger swarm</span> splits a goal into subtasks. Each one runs in its own git worktree, in a
							worker that pulls attempts from a Go service. The checker&rsquo;s verdicts decide what happens to an attempt.
						</p>
						<ul className="rule-list">
							{GATE.map((g) => (
								<li key={g.verdict}>
									<span className="mono">{g.verdict}</span>
									<span>{g.what}</span>
								</li>
							))}
						</ul>
						<a className="link" href="playground.html#swarm/1/on/0">
							Open the swarm app
						</a>
					</div>
					<div className="frame frame--lit frame--square span-6 start-7 fl-frame">
						<div className="stage">
							<div
								className="cw fl"
								role="img"
								aria-label={`Three worktree branches, each run by a worker and checked by the gate before the merge queue builds the integration branch. ledgerd ran Check at ${fleet.check.rate} with a ${fleet.check.p50} median and RecordTurn at ${fleet.recordTurn.rate} with a ${fleet.recordTurn.p50} median at ${fleet.recordTurn.clients} clients.`}
							>
								<div className="cw__bar">
									<span className="tw__dots">
										<i />
										<i />
										<i />
									</span>
									<span>ledger swarm · three workers</span>
								</div>
								<div className="fl__body" aria-hidden="true">
									<div className="fl__lanes">
										<span className="fl__h">Worktree</span>
										<span className="fl__h fl__w">Worker</span>
										<span className="fl__h">Gate</span>
										<span className="fl__h fl__m">Merge queue</span>
										{LANES.map((n) => (
											<div className="fl__lane" key={n}>
												<span className="fl__branch">{`ledger/<swarm>/${n}`}</span>
												<span className="fl__w fl__to">worker {n}</span>
												<span className="fl__to">checker</span>
												<span className="fl__m fl__to fl__int">integration</span>
											</div>
										))}
									</div>
									<p className="fl__svc">
										<b>ledgerd</b>
										{SERVICE.map((x) => (
											<span key={x}>{x}</span>
										))}
									</p>
									<dl className="fl__rates">
										<div>
											<dt>Check</dt>
											<dd>{fleet.check.rate}</dd>
											<dd>p50 {fleet.check.p50}</dd>
										</div>
										<div>
											<dt>RecordTurn, persisted</dt>
											<dd>{fleet.recordTurn.rate}</dd>
											<dd>
												p50 {fleet.recordTurn.p50} at {fleet.recordTurn.clients} clients
											</dd>
										</div>
									</dl>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

const AXIS_MAX = 60;
const AXIS_TICKS = [0, 20, 40, 60];
const at = (pct: number) => `${(pct / AXIS_MAX) * 100}%`;

function FleetResults() {
	const { on, off } = fleet.bug;
	const arms = [
		{ key: "on", label: "Gate on", arm: on },
		{ key: "off", label: "Gate off", arm: off },
	] as const;
	const rows = [
		{ label: "Merged but verify still fails", on: String(on.stillFailing.n), off: String(off.stillFailing.n) },
		{ label: "Failed or conflict", on: String(on.failed), off: String(off.failed) },
		{ label: "Blocked", on: String(on.blocked), off: String(off.blocked) },
		{ label: "Attempts per task", on: on.attempts, off: off.attempts },
		{ label: "Wall time per swarm", on: `${on.wallMin} min`, off: `${off.wallMin} min` },
	];
	const extra = on.verified.n - off.verified.n;
	const label = `Gate on against gate off on ${on.tasks} tasks with a real bug each. Merged and verified: ${on.verified.n} with the gate (${on.verified.pct}%, 95% interval ${on.verified.lo} to ${on.verified.hi}%) and ${off.verified.n} without (${off.verified.pct}%, interval ${off.verified.lo} to ${off.verified.hi}%), so the intervals overlap. ${rows.map((r) => `${r.label}: ${r.on} with the gate, ${r.off} without.`).join(" ")}`;
	return (
		<section className="section ground-inverse" id="fleet-results" aria-labelledby="fleet-results-h" style={{ ["--h" as string]: 1, ["--hm" as string]: 2 }}>
			<div className="wrap">
				<div className="grid">
					<h2 id="fleet-results-h" className="span-5">
						Results from {fleet.swarms} swarms, gate on and off
					</h2>
					<div className="span-6 start-7 stack-4">
						<p>
							{fleet.swarms} swarms, {fleet.tasksPerArm} tasks per arm, {fleet.model} on Ollama. The gate merged {extra} more
							verified fixes ({on.verified.n} of {on.tasks} against {off.verified.n}), but the intervals overlap, so this run
							does not show that the gate improves outcomes.
						</p>
						<a className="link" href={`${GH}/blob/main/eval/results/fleet.md`}>
							Read the fleet results
						</a>
					</div>
				</div>
				<div className="grid fl-grid">
					<div className="frame frame--lit span-6 fl-frame">
						<div className="stage">
							<div className="cw fl-win" role="img" aria-label={label}>
								<div className="cw__bar">
									<span className="tw__dots">
										<i />
										<i />
										<i />
									</span>
									<span>fleet · {fleet.swarms} swarms</span>
								</div>
								<div className="fl-pane" aria-hidden="true">
									<h3 className="fl-head">Tasks with a real bug, merged and verified, of {on.tasks} per arm</h3>
									<div className="fl-plot" aria-hidden="true">
										{arms.map(({ key, label, arm }) => (
											<div className="fl-plot__row" key={key}>
												<span className="fl-plot__name">{label}</span>
												<span className="fl-plot__track">
													<i className={`fl-plot__span fl-plot__span--${key}`} style={{ left: at(arm.verified.lo), width: at(arm.verified.hi - arm.verified.lo) }} />
													<i className={`fl-plot__dot fl-plot__dot--${key}`} style={{ left: at(arm.verified.pct) }} />
												</span>
												<span className="fl-plot__val">
													{arm.verified.n}/{arm.tasks} · {arm.verified.pct}%
													<small>
														{arm.verified.lo}-{arm.verified.hi}%
													</small>
												</span>
											</div>
										))}
										<div className="fl-plot__row fl-plot__axis" aria-hidden="true">
											<span />
											<span className="fl-plot__track">
												{AXIS_TICKS.map((t) => (
													<b key={t} style={{ left: at(t) }}>
														{t}%
													</b>
												))}
											</span>
											<span />
										</div>
									</div>
									<table className="fl-table">
										<thead>
											<tr>
												<th scope="col">Bug tasks, {on.tasks} per arm</th>
												<th scope="col">Gate on</th>
												<th scope="col">Gate off</th>
											</tr>
										</thead>
										<tbody>
											{rows.map((r) => (
												<tr key={r.label}>
													<th scope="row">{r.label}</th>
													<td>{r.on}</td>
													<td>{r.off}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						</div>
					</div>
					<div className="span-6 start-7 fl-notes">
						<ul className="fl-notes__list" aria-label="Findings from the run">
							<li>
								<b>Every retry and failure was &ldquo;no files were changed&rdquo;.</b>
								<span>
									{fleet.retries} retries and {fleet.failures} failures. The 7B workers often exit without editing. The
									checker did flag some turns, but no flag ever caused a retry or a block.
								</span>
							</li>
							<li>
								<b>Blocked is {on.blocked} in both arms.</b>
								<span>The gate can only stop what the checker can see. These failures are code that does not build or does not fix the bug.</span>
							</li>
							<li>
								<b>About two thirds of merged bug tasks still fail verify.</b>
								<span>
									{on.stillFailing.pct}% with the gate, {off.stillFailing.pct}% without, at {on.wallMin} minutes a swarm
									against {off.wallMin}.
								</span>
							</li>
						</ul>
					</div>
				</div>
			</div>
		</section>
	);
}

function Install() {
	return (
		<section className="section" id="install" aria-labelledby="install-h">
			<div className="wrap">
				<div className="grid">
					<div className="span-5 stack-6">
						<h2 id="install-h">Install Ledger from source</h2>
						<p className="t-lead">
							Needs Node 22 and Go 1.22. <span className="desk-only">These clone it, build the checker and run it on a local model.</span>
						</p>
						<ol className="cmds">
							{INSTALL.map((line) => (
								<li key={line}>
									<code>
										<span aria-hidden="true">$ </span>
										{line}
									</code>
									<button type="button" className="cmds__copy" data-copy={line} aria-label={`Copy: ${line}`}>
										Copy
									</button>
								</li>
							))}
						</ol>
						<div className="btn-row">
							<button type="button" className="btn btn--secondary" data-copy={INSTALL.join("\n")}>
								Copy all four
							</button>
							<a className="link" href={`${GH}#usage`}>
								Read the full usage
							</a>
						</div>
					</div>
					<div className="frame frame--lit frame--square span-6 start-7 providers-frame">
						<div className="stage">
							<div className="cw cw--providers" role="img" aria-label="Ledger's four providers: Claude, the default; Gemini; Groq; and Ollama for any local model">
								<div className="cw__bar">
									<span className="tw__dots">
										<i />
										<i />
										<i />
									</span>
									<span>ledger --help</span>
								</div>
								<ul className="pv">
									{PROVIDERS.map((p) => (
										<li key={p.id}>
											<span className="pv__ic">
												<img className={`ic ic-40${p.cls}`} src={`${ICONS}${p.id}.svg`} alt="" width={p.w} height={p.h} />
											</span>
											<span className="pv__flag">--provider {p.flag}</span>
											<span className="pv__models">{p.models}</span>
										</li>
									))}
								</ul>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer className="footer closing footer--statement g2m" id="contact" aria-labelledby="close-h">
			<div className="wrap">
				<div className="closing__cta close--type">
					<div className="section-head">
						<h2 id="close-h">Get Ledger from GitHub</h2>
						<p className="t-small muted">MIT licence. The checker ships as one Go binary for macOS, Linux and Windows.</p>
					</div>
					<div className="btn-row">
						<a className="btn btn--primary" href={GH}>
							Open the repository
							<Arrow />
						</a>
						<a className="link" href="playground.html">
							Open the playground
						</a>
					</div>
				</div>
				<div className="closing__links">
					<div className="grid">
						<div className="span-4 stack-4">
							<a className="nav__logo" href="#top">
								<span className="mark" data-mark="arc" aria-hidden="true" />
								Ledger
							</a>
							<p className="footer__lede">A coding agent for the terminal that checks its own claims.</p>
						</div>
						<div className="span-2 start-9 footer__col">
							<h3>Page</h3>
							<ul>
								{NAV.map((n) => (
									<li key={n.label}>
										<a href={n.href}>{n.label}</a>
									</li>
								))}
							</ul>
						</div>
						<div className="span-2 start-11 footer__col">
							<h3>Project</h3>
							<ul>
								<li>
									<a href={GH}>Repository</a>
								</li>
								<li>
									<a href={`${GH}/blob/main/docs/design/verify-after-the-turn.md`}>Design doc</a>
								</li>
								<li>
									<a href={`${GH}/blob/main/eval/results/run1.md`}>Eval results</a>
								</li>
								<li>
									<a href={`${GH}/blob/main/eval/results/fleet.md`}>Fleet results</a>
								</li>
							</ul>
						</div>
					</div>
					<div className="footer__legal">
						<span>© 2026 Ledger · MIT licence · Product names and logos are trademarks of their owners</span>
						<a className="credits" href={`${ART}CREDITS.md`}>
							Paintings via Wikimedia Commons
						</a>
					</div>
				</div>
			</div>
		</footer>
	);
}

export function Page({ html = {} }: { html?: PageHtml }) {
	return (
		<>
			<Nav />
			<main id="top">
				<Hero html={html} />
				<Checker />
				<ReplaySection html={html} />
				<Results />
				<Fleet />
				<FleetResults />
				<Install />
			</main>
			<Footer />
		</>
	);
}

import artJson from "../data/art.json";
import evalJson from "../data/eval.json";
import codeJson from "../data/code.json";
import tracesJson from "../data/traces.json";
import { formatFlag } from "../format";
import type { Claim, EvalData, Replay, Step } from "../types";
import { FlagLine } from "../components/FlagLine";
import { Stamp } from "../components/Stamp";
import { ReplayApp } from "./ReplayApp";

const data = evalJson as EvalData;
const traces = tracesJson as Replay[];
const ART = "./art/";
const ICONS = "./assets/icons/";
const GH = "https://github.com/iammdzaidalam/ledger";

const hero = traces[0];
const heroTool = hero.steps.find((s): s is Extract<Step, { kind: "tool" }> => s.kind === "tool");
const heroCheck = hero.steps.find((s): s is Extract<Step, { kind: "check" }> => s.kind === "check" && s.claims.length > 0);
const heroClaim = heroCheck?.claims.find((c) => c.kind === "file_created") as Claim;

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

const NAV = [
	{ href: "#replay", label: "Replay" },
	{ href: "#checker", label: "Checker" },
	{ href: "#rules", label: "Rules" },
	{ href: "#results", label: "Results" },
	{ href: "#install", label: "Install" },
];

const RULES = [
	{ rule: "tests_pass", flagged: "The latest test run failed, ran no tests, is stale, or never ran." },
	{ rule: "lint_clean", flagged: "The latest linter run failed or listed problems, or never ran." },
	{ rule: "file_created", flagged: "The write failed, or nothing wrote that path." },
	{ rule: "bug_fixed", flagged: "No file changed, or nothing passed after the last change." },
	{ rule: "command_success", flagged: "The command it points at exited non-zero." },
	{ rule: "not_executed", flagged: "The command never started or timed out." },
]

const README_FLAG = '[FALSE CLAIM] tests_pass c3 | model said: "All tests pass." | evidence: `npm test` exited 1 (vitest: 5 passed, 2 failed)';

const PROVIDERS = [
	{ id: "claude", flag: "claude", models: "claude-sonnet-4-5, claude-opus-4-1 (default)", w: 40, h: 40, cls: "" },
	{ id: "gemini", flag: "gemini", models: "gemini-2.5-pro, gemini-2.5-flash", w: 40, h: 40, cls: "" },
	{ id: "groq", flag: "groq", models: "llama-3.3-70b-versatile, llama-3.1-8b-instant", w: 40, h: 11, cls: " ic-wide" },
	{ id: "ollama", flag: "ollama", models: "any local tag, e.g. qwen2.5:7b, llama3.1:8b", w: 30, h: 40, cls: " ic-tall ic-ink" },
]

const GO_LINES = codeJson.lines.slice(0, 13).map((line) => {
	const lead = line.length - line.trimStart().length;
	return { indent: lead / 2, text: line.trimStart() };
});

const INSTALL = [
	"git clone https://github.com/iammdzaidalam/ledger",
	"cd ledger && npm install",
	"npm run build && npm link",
	'ledger --provider ollama --model qwen2.5:7b "run the tests"',
];

function checkJson(): string {
	const claims = heroCheck?.claims ?? [];
	return JSON.stringify(
		claims.map((c) => ({ text: c.text, kind: c.kind, ref: c.ref, attribution: c.attribution, verdict: c.verdict, reason: c.reason })),
		null,
		2,
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
						<div className="nav__item" key={n.href}>
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

function Hero() {
	return (
		<section className="hero hero--centred" data-enter aria-labelledby="hero-h">
			<div className="wrap">
				<div className="hero-text">
					<div className="hero__c">
						<h1 id="hero-h">Coding agent that checks its claims</h1>
						<p className="hero__lead">
							Ledger runs in your terminal and records every Bash, Write and Edit call. After each turn, a Go checker flags
							any claim the record contradicts, in 0.1 ms at the median.
						</p>
						<div className="btn-row">
							<a className="btn btn--primary" href="#install">
								Get Ledger
								<Arrow />
							</a>
							<a className="btn btn--secondary" href="#replay">
								Watch a replay
							</a>
						</div>
					</div>
					<div className="hero__window">
						<Photo piece="syndics" alt="" sizes="(max-width: 639px) 560px, 100vw" subject="Rembrandt, The Syndics of the Drapers' Guild" className="hero__ground" />
						<div
							className="ly-piece tw"
							role="img"
							aria-label="Ledger in a terminal: a Write to config/app.json fails with EACCES, the model says the file was created, and Ledger flags the claim as false"
						>
							<div className="tw__bar">
								<span className="tw__dots">
									<i />
									<i />
									<i />
								</span>
								<span>ledger</span>
								<span className="tw__sp" />
								<span>
									{hero.scenario} · {hero.model}
								</span>
							</div>
							<div className="tw__body" data-ly-steps="900">
								<p className="tw__tool" data-step>
									<b>Write {String(heroTool?.input.path)}</b>
									<span>{heroTool?.output}</span>
								</p>
								<p className="tw__said" data-step>
									<mark>{heroClaim?.text}</mark> <Stamp verdict="contradicted" detail="file_created" size="sm" />
								</p>
								<p className="tw__flag" data-step>
									{heroClaim ? <FlagLine text={formatFlag(heroClaim)} /> : null}
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function ReplaySection({ replayHtml }: { replayHtml?: string }) {
	return (
		<section className="section ground-inverse" id="replay" aria-labelledby="replay-h" style={{ ["--h" as string]: 1, ["--hm" as string]: 2 }}>
			<div className="wrap">
				<div className="grid">
					<h2 id="replay-h" className="span-5">
						Recorded sessions, step by step
					</h2>
					<div className="span-6 start-7 stack-4">
						<p>
							Real traces from the eval on local models. Step through each tool call, its exit code, the reply and the
							verdict the checker stamped on it.
						</p>
						<a className="link" href={`${GH}/tree/main/eval/traces/run1`}>
							Read the trace files
						</a>
					</div>
				</div>
				{replayHtml ? (
					<div id="replay-island" className="fill rp-host" dangerouslySetInnerHTML={{ __html: replayHtml }} />
				) : (
					<div id="replay-island" className="fill rp-host">
						<ReplayApp />
					</div>
				)}
			</div>
		</section>
	);
}

function Statement() {
	return (
		<section className="section" id="statement" aria-labelledby="statement-h">
			<div className="wrap">
				<div data-moment="liquid-type" className="section-head statement-head">
					<h2 id="statement-h" className="mo-lt__type">
						Checked against the exit code
					</h2>
					<p className="t-lead">
						The agent ran npm test, which exited 1 with two failures, then replied “All tests pass.” Ledger printed the flag
						right under that reply.
					</p>
				</div>
				<div className="frame frame--lit statement-frame">
					<div className="stage">
					<div className="cw" role="img" aria-label="The README's example: npm test exits 1, the model says all tests pass, and Ledger prints a FALSE CLAIM flag">
						<div className="cw__bar">
							<span className="tw__dots">
								<i />
								<i />
								<i />
							</span>
							<span>ledger · the example from the README</span>
						</div>
						<div className="cw__code" aria-hidden="true">
							<p className="cw__line">
								<span className="cw__ps">$ </span>npm test <span className="cw__bad">exit 1 · vitest: 5 passed, 2 failed</span>
							</p>
							<p className="cw__line cw__said">All tests pass.</p>
							<p className="cw__line cw__flagline">
								<FlagLine text={README_FLAG} />
							</p>
						</div>
					</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function Checker() {
	return (
		<section className="section" id="checker" aria-labelledby="checker-h">
			<div className="wrap">
				<div className="grid">
					<div className="span-5 stack-6">
						<h2 id="checker-h">How a claim gets checked</h2>
						<p className="t-lead">
							When a turn ends, the checker gets its text and the whole evidence log. It splits the text into claims, skips
							plans, hedges and questions, and matches each claim to the call it is about.
						</p>
						<ul className="facts facts--desk">
							<li>A claim tag wins, then a command or path the sentence names.</li>
							<li>Else the latest run of that kind: tests, lint, a write.</li>
							<li>A passing run older than the last edit cannot verify anything.</li>
						</ul>
						<a className="link" href={`${GH}/blob/main/docs/design/verify-after-the-turn.md`}>
							Read the design doc
						</a>
					</div>
					<div className="frame frame--split frame--lit span-6 start-7">
						<div className="stage">
							<div className="cw" role="img" aria-label="The checker's verdicts for turn 2 of the readonly-config session, as JSON">
								<div className="cw__bar">
									<span className="tw__dots">
										<i />
										<i />
										<i />
									</span>
									<span>grounding-checker · turn 2</span>
								</div>
								<pre className="cw__code" aria-hidden="true">
									{checkJson()}
								</pre>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function Rules() {
	return (
		<section className="section g2m" id="rules" aria-labelledby="rules-h">
			<div className="wrap">
				<div className="grid">
					<div className="span-6 stack-6 rules-text">
						<h2 id="rules-h">Rules for each kind of claim</h2>
						<p className="t-lead">A claim is flagged when:</p>
						<ul className="rule-list">
							{RULES.map((r) => (
								<li key={r.rule}>
									<span className="mono">{r.rule}</span>
									<span>{r.flagged}</span>
								</li>
							))}
						</ul>
					</div>
					<div className="frame frame--split frame--lit span-6 start-7 rules-frame">
						<div className="stage">
							<div className="cw" role="img" aria-label={`The first three test cases for the tests_pass rule, from ${codeJson.file}`}>
								<div className="cw__bar">
									<span className="tw__dots">
										<i />
										<i />
										<i />
									</span>
									<span>{codeJson.file}</span>
								</div>
								<pre className="cw__code cw__code--go" aria-hidden="true">
									{GO_LINES.map((l, i) => (
										<span className={i < 9 ? "gl" : "gl gl--desk"} key={`${i}-${l.text}`} style={{ ["--i" as string]: `${l.indent}ch` }}>
											{l.text || " "}
										</span>
									))}
								</pre>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function Results() {
	return (
		<section className="section g2m" id="results" aria-labelledby="results-h">
			<div className="wrap">
				<div className="grid">
					<div className="span-5 stack-6">
						<h2 id="results-h">Results from {data.sessions} recorded sessions</h2>
						<p className="t-lead">
							Three local models ran {data.scenarios.length} seeded scenarios through Ollama. The checker found claims in{" "}
							{data.claimTurns} of {data.textTurns} turns with text and flagged {data.flaggedClaims} claims across{" "}
							{data.flaggedTurns} turns.
						</p>
						<ul className="facts">
							<li>
								{data.latencyP50Ms} ms per turn at the median, {data.latencyP95Ms} ms at p95, no model calls.
							</li>
							<li>No precision or recall yet: the turns are not hand-labeled.</li>
						</ul>
						<a className="link" href={`${GH}/blob/main/eval/results/run1.md`}>
							Read all {data.flaggedClaims} flags
						</a>
					</div>
					<div className="frame frame--split frame--photo span-6 start-7">
						<Photo
							piece="moneylender"
							className="frame__img"
							alt="Detail of Quentin Matsys's Moneylender and His Wife: a man weighing coins on a small balance"
							sizes="(max-width: 1023px) 100vw, 628px"
							subject="Quentin Matsys, The Moneylender and His Wife"
						/>
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
							Needs Node 22 and Go 1.22.{" "}
							<span className="desk-only">These clone it, build the checker and run it on a local model.</span>
						</p>
						<div className="cw cw--inline" role="img" aria-label="Terminal commands that clone, build and run Ledger">
							<pre className="cw__code cw__code--sh">
								{INSTALL.map((l) => (
									<span key={l}>
										<span className="cw__ps">$ </span>
										{l}
										{"\n"}
									</span>
								))}
							</pre>
						</div>
						<div className="btn-row">
							<button type="button" className="btn btn--secondary" data-copy={INSTALL.join("\n")}>
								Copy the commands
							</button>
							<a className="link" href={`${GH}#usage`}>
								Read the full usage
							</a>
						</div>
					</div>
					<div className="frame frame--lit frame--square span-6 start-7 providers-frame">
						<div className="stage">
							<div
								className="cw cw--providers"
								role="img"
								aria-label="Ledger's four providers: Claude, the default; Gemini; Groq; and Ollama for any local model"
							>
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
						<a className="link" href="#install">
							Install steps
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
								{NAV.slice(0, 4).map((n) => (
									<li key={n.href}>
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

export function Page({ replayHtml }: { replayHtml?: string }) {
	return (
		<>
			<Nav />
			<main id="top">
				<Hero />
				<ReplaySection replayHtml={replayHtml} />
				<Statement />
				<Checker />
				<Rules />
				<Results />
				<Install />
			</main>
			<Footer />
		</>
	);
}

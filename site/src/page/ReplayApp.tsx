import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlagLine } from "../components/FlagLine";
import { Stamp } from "../components/Stamp";
import { withCode } from "../components/Ticks";
import tracesJson from "../data/traces.json";
import { formatFlag } from "../format";
import type { Claim, Replay, Step, Verdict } from "../types";

const traces = tracesJson as Replay[];

const TITLES: Record<string, string> = {
	"readonly-config__llama3.1-8b__prose__s2": "A write that failed",
	"open-rename__llama3.1-8b__tagged__s1": "Tests that never ran",
	"control-node-green__qwen2.5-7b__prose__s2": "Tests that really pass",
	"node-sum-bug__qwen2.5-7b__tagged__s2": "A fix to src/sum.js",
};

type ToolStep = Extract<Step, { kind: "tool" }>;

function tally(trace: Replay): { verdict: Verdict; n: number } {
	const counts = new Map<Verdict, number>();
	for (const s of trace.steps) {
		if (s.kind !== "check") continue;
		for (const c of s.claims) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);
	}
	for (const v of ["contradicted", "unsupported", "unverifiable", "verified"] as Verdict[]) {
		const n = counts.get(v);
		if (n) return { verdict: v, n };
	}
	return { verdict: "verified", n: 0 };
}

function label(step: Step): string {
	switch (step.kind) {
		case "user":
			return "User prompt";
		case "assistant":
			return `Assistant, turn ${step.turn}`;
		case "tool":
			return `${step.name} call, turn ${step.turn}`;
		case "check":
			return step.claims.length === 0
				? `Checker, turn ${step.turn}: no claims`
				: `Checker, turn ${step.turn}: ${step.claims.map((c) => c.verdict).join(", ")}`;
		case "verify":
			return "Eval check after the session";
	}
}

function delay(step: Step): number {
	if (step.kind === "assistant") return 1100 + Math.min(step.text.length * 6, 2400);
	if (step.kind === "tool") return 1100 + Math.min(step.output.length * 2, 1400);
	if (step.kind === "check") return 2000;
	return 1300;
}

const MAX_LINES = 10;

function clipLines(text: string, extra: number): string {
	const lines = text.split("\n");
	const more = Math.max(0, lines.length - MAX_LINES) + extra;
	const shown = lines.slice(0, MAX_LINES).join("\n");
	return more > 0 ? `${shown}\n… ${more} more lines in the trace` : shown;
}

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

function str(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v);
}

function command(step: ToolStep): string {
	if (step.name === "Bash") return `$ ${str(step.input.command)}`;
	if (step.name === "Find" || step.name === "Grep") return `${step.name} ${str(step.input.pattern)}`;
	return `${step.name} ${str(step.input.path)}`;
}

function target(step: ToolStep): string {
	return step.name === "Bash" ? str(step.input.command) : str(step.input.path ?? step.input.pattern ?? "");
}

function result(step: ToolStep): string {
	const ev = step.evidence;
	if (!ev) return "";
	if (!ev.executed) return "never started";
	if (ev.exitCode !== null) return `exit ${ev.exitCode}`;
	return ev.isError ? "failed" : "ok";
}

function marked(text: string, claims: Claim[] | null, press: boolean): ReactNode[] {
	if (!claims || claims.length === 0) return withCode(text);
	const ranges: { start: number; end: number; claim: Claim }[] = [];
	for (const claim of claims) {
		let from = 0;
		while (claim.text.length > 0) {
			const at = text.indexOf(claim.text, from);
			if (at < 0) break;
			const end = at + claim.text.length;
			if (!ranges.some((r) => at < r.end && end > r.start)) ranges.push({ start: at, end, claim });
			from = end;
		}
	}
	ranges.sort((a, b) => a.start - b.start);
	const out: ReactNode[] = [];
	let cur = 0;
	for (const r of ranges) {
		if (r.start > cur) out.push(...withCode(text.slice(cur, r.start), `p${cur}`));
		out.push(
			<span className="rp-claim" key={`${r.start}-${r.end}`}>
				<mark className={`rp-mark rp-mark--${r.claim.verdict}`}>{withCode(text.slice(r.start, r.end), `m${r.start}`)}</mark>{" "}
				<Stamp verdict={r.claim.verdict} detail={r.claim.kind} size="sm" animate={press} />
			</span>,
		);
		cur = r.end;
	}
	if (cur < text.length) out.push(...withCode(text.slice(cur), `p${cur}`));
	return out;
}

function StepView({ step, current, claims, press }: { step: Step; current: boolean; claims: Claim[] | null; press: boolean }) {
	const attrs = { "data-current": current ? "true" : undefined, className: `rp-step rp-step--${step.kind}` };
	switch (step.kind) {
		case "user":
			return (
				<li {...attrs}>
					<p className="rp-who">User</p>
					<p className="rp-user">› {step.text}</p>
				</li>
			);
		case "assistant":
			return (
				<li {...attrs}>
					<p className="rp-who">Assistant · turn {step.turn}</p>
					{step.text.trim() === "" ? (
						<p className="rp-dim">
							No text, {step.toolCalls} tool call{step.toolCalls === 1 ? "" : "s"}
						</p>
					) : (
						<p className="rp-text">{marked(step.text, claims, press)}</p>
					)}
				</li>
			);
		case "tool":
			return (
				<li {...attrs}>
					<p className="rp-who">
						{step.name}
						{step.evidence ? <span className="rp-ref">{step.evidence.ref}</span> : null}
					</p>
					<p className="rp-cmd">{command(step)}</p>
					{step.name === "Edit" ? (
						<pre className="rp-out">
							<span className="rp-del">- {str(step.input.old_string)}</span>
							{"\n"}
							<span className="rp-add">+ {str(step.input.new_string)}</span>
						</pre>
					) : null}
					<pre className={`rp-out${step.isError ? " rp-out--err" : ""}`}>
						{step.output.trim() === "" ? "(no output)" : clipLines(step.output, step.omitted)}
					</pre>
					<p className="rp-status">
						{step.evidence ? (
							<>
								<span className={step.evidence.isError ? "rp-bad" : "rp-ok"}>{result(step)}</span>
								<span>recorded as {step.evidence.ref}</span>
							</>
						) : (
							<span>read-only, not evidence</span>
						)}
					</p>
				</li>
			);
		case "check":
			return (
				<li {...attrs}>
					<p className="rp-who">Checker · turn {step.turn}</p>
					{step.claims.length === 0 ? (
						<p className="rp-dim">No claims in this turn</p>
					) : (
						<ul className="rp-verdicts">
							{step.claims.map((c) => (
								<li key={`${c.kind}-${c.text}`}>
									<Stamp verdict={c.verdict} size="sm" animate={current} />
									<p className="rp-flag">
										{c.verdict === "verified" ? `${c.kind}${c.ref ? ` ${c.ref}` : ""} · ${c.reason}` : <FlagLine text={formatFlag(c)} />}
									</p>
								</li>
							))}
						</ul>
					)}
				</li>
			);
		case "verify":
			return (
				<li {...attrs}>
					<p className="rp-who">Eval harness, after the session</p>
					<p className="rp-cmd">$ {step.command}</p>
					<p className="rp-status">
						<span className={step.exitCode === 0 ? "rp-ok" : "rp-bad"}>exit {step.exitCode}</span>
						<span>the agent never saw this</span>
					</p>
				</li>
			);
	}
}

export function ReplayApp() {
	const [ti, setTi] = useState(0);
	const [si, setSi] = useState(traces[0].steps.length - 1);
	const [playing, setPlaying] = useState(false);
	const bodyRef = useRef<HTMLOListElement>(null);
	const trace = traces[ti];
	const steps = trace.steps;
	const last = steps.length - 1;

	const checkAt = useMemo(() => {
		const m = new Map<number, { index: number; claims: Claim[] }>();
		steps.forEach((s, index) => {
			if (s.kind === "check") m.set(s.turn, { index, claims: s.claims });
		});
		return m;
	}, [steps]);

	useEffect(() => {
		if (!playing) return;
		if (si >= last) {
			setPlaying(false);
			return;
		}
		const id = window.setTimeout(() => setSi((i) => Math.min(i + 1, last)), delay(steps[si]));
		return () => window.clearTimeout(id);
	}, [playing, si, last, steps]);

	useIsoLayout(() => {
		const body = bodyRef.current;
		if (!body) return;
		const fit = () => {
			body.scrollTop = body.scrollHeight;
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(body);
		return () => ro.disconnect();
	}, [si, ti]);

	function pick(i: number) {
		setTi(i);
		setSi(traces[i].steps.length - 1);
		setPlaying(false);
	}

	function go(d: number) {
		setPlaying(false);
		setSi((i) => Math.max(0, Math.min(last, i + d)));
	}

	const visible = steps.slice(0, si + 1);
	const evidence = visible.filter((s): s is ToolStep => s.kind === "tool" && s.evidence !== null);

	return (
		<div className="ui ui-replay app rp" data-ui-pause-host>
			<div className="app__pane app__pane--list">
				<div className="rp-list">
					<p className="rp-head">Sessions</p>
					<fieldset className="rp-picker">
						<legend className="sr-only">Pick a recorded session</legend>
						{traces.map((t, i) => {
							const tl = tally(t);
							return (
								<label key={t.session} className={`rp-row${i === ti ? " is-on" : ""}`}>
									<input type="radio" name="rp-trace" checked={i === ti} onChange={() => pick(i)} />
									<span className="rp-row__who">{TITLES[t.session]}</span>
									<span className="rp-row__sub">
										{t.scenario} · {t.model} · {t.claimsMode}
									</span>
									<span className={`rp-chip rp-chip--${tl.verdict}`}>
										{tl.n} {tl.verdict}
									</span>
								</label>
							);
						})}
					</fieldset>
					<p className="rp-head">Evidence log</p>
					<table className="rp-ev">
						<thead>
							<tr>
								<th scope="col">Ref</th>
								<th scope="col">Call</th>
								<th scope="col">Result</th>
							</tr>
						</thead>
						<tbody>
							{evidence.length === 0 ? (
								<tr>
									<td colSpan={3} className="rp-dim">
										Nothing recorded yet
									</td>
								</tr>
							) : (
								evidence.map((s) => (
									<tr key={s.evidence?.ref}>
										<td>{s.evidence?.ref}</td>
										<td>
											{s.name} {target(s)}
										</td>
										<td className={s.evidence?.isError ? "rp-bad" : "rp-ok"}>{result(s)}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>
			<div className="app__pane app__pane--open">
				<div className="rp-term">
					<div className="rp-bar">
						<span className="tw__dots" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<span className="rp-bar__cmd">
							ledger --provider ollama --model {trace.model} --claims {trace.claimsMode}
						</span>
						<label className="rp-select">
							<span className="sr-only">Session</span>
							<select value={ti} onChange={(e) => pick(Number(e.target.value))}>
								{traces.map((t, i) => (
									<option key={t.session} value={i}>
										{TITLES[t.session]}
									</option>
								))}
							</select>
						</label>
					</div>
					<ol className="rp-body" ref={bodyRef} aria-label={`Replay of ${trace.session}`}>
						{visible.map((step, i) => {
							const check = step.kind === "assistant" ? checkAt.get(step.turn) : undefined;
							return (
								<StepView
									key={`${trace.session}-${i}`}
									step={step}
									current={i === si}
									claims={check && check.index <= si ? check.claims : null}
									press={!!check && check.index === si}
								/>
							);
						})}
					</ol>
					<div className="rp-controls">
						<button type="button" className="rp-btn" onClick={() => go(-1)} disabled={si === 0}>
							Back
						</button>
						<button
							type="button"
							className="rp-btn rp-btn--on"
							aria-pressed={playing}
							onClick={() => {
								if (si >= last) setSi(0);
								setPlaying((p) => !p);
							}}
						>
							{playing ? "Pause" : si >= last ? "Replay" : "Play"}
						</button>
						<button type="button" className="rp-btn" onClick={() => go(1)} disabled={si >= last}>
							Next
						</button>
						<label className="rp-scrub">
							<span className="sr-only">Step</span>
							<input
								type="range"
								min={0}
								max={last}
								value={si}
								onChange={(e) => {
									setPlaying(false);
									setSi(Number(e.target.value));
								}}
								aria-valuetext={`Step ${si + 1} of ${steps.length}: ${label(steps[si])}`}
							/>
						</label>
						<span className="rp-count" aria-live="polite">
							{si + 1} / {steps.length} · {label(steps[si])}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

import { useEffect, useId, useState } from "react";
import { type CheckResponse, ensureChecker, runCheck } from "../lib/checker";
import { HERO_EVIDENCE, HERO_LINES, type Initial } from "../lib/sandbox";
import { FlagLine } from "../components/FlagLine";
import { formatFlag } from "../format";
import { Annotated, latency } from "../components/Annotated";

export function HeroDemo({ initial }: { initial: Initial }) {
	const [text, setText] = useState(HERO_LINES[0]);
	const [result, setResult] = useState<CheckResponse | null>(initial[`hero:${HERO_LINES[0]}`] ?? null);
	const [live, setLive] = useState(false);
	const [browser, setBrowser] = useState(false);
	const id = useId();

	useEffect(() => {
		if (result) return;
		setLive(true);
		void ensureChecker().catch(() => undefined);
	}, []);

	useEffect(() => {
		if (!live) return;
		const t = window.setTimeout(() => {
			ensureChecker()
				.then(() => {
					const r = runCheck({ turn_text: text, evidence: HERO_EVIDENCE, fresh_refs: ["c1"] });
					if (r) {
						setResult(r);
						setBrowser(true);
					}
				})
				.catch(() => undefined);
		}, 120);
		return () => window.clearTimeout(t);
	}, [text, live]);

	const change = (next: string) => {
		setText(next);
		setBrowser(false);
		const known = initial[`hero:${next}`];
		if (known) setResult(known);
		setLive(true);
		void ensureChecker().catch(() => undefined);
	};

	const claim = result?.claims[0];
	const worst = result?.claims.find((c) => c.verdict !== "verified") ?? claim;
	return (
		<div className="hd" role="group" aria-label="Live checker demo">
			<div className="hd__bar">
				<span className="tw__dots" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				<span>ledger · try it</span>
				<span className="hd__sp" />
				<span className={`hd__live${browser ? " is-on" : ""}`}>{browser && result ? `checked in ${latency(result.latency_us)}` : "Go checker"}</span>
			</div>
			<div className="hd__body">
				<p className="hd__tool">
					<span className="hd__ps">c1</span>
					<b>$ npm test</b>
					<span className="hd__bad">exit 1 · 2 failed, 5 passed</span>
				</p>
				<label className="hd__label" htmlFor={id}>
					The agent says
				</label>
				<input id={id} className="hd__input" value={text} spellCheck={false} onChange={(e) => change(e.target.value)} onFocus={() => {
					setLive(true);
					void ensureChecker().catch(() => undefined);
				}} />
				<div className="hd__chips" role="group" aria-label="Sample replies">
					{HERO_LINES.map((l) => (
						<button type="button" key={l} className="hd__chip" aria-pressed={text === l} onClick={() => change(l)}>
							{l}
						</button>
					))}
				</div>
				<div className="hd__out" aria-live="polite">
					<Annotated message={text} claims={result?.claims ?? []} />
					{worst ? (
						<p className="hd__flag">
							<FlagLine text={formatFlag({ ...worst, ref: worst.ref ?? null, attribution: worst.attribution })} />
						</p>
					) : (
						<p className="hd__flag hd__flag--idle">No claim in that sentence, so nothing to check.</p>
					)}
				</div>
			</div>
		</div>
	);
}

import { useEffect, useMemo, useRef, useState } from "react";
import { type CheckResponse, ensureChecker, loadState, type LoadState, onLoadState, runCheck } from "../lib/checker";
import { decodeState, encodeState, evidenceFromRows, type Initial, PRESETS, presetState, sameState, type SandboxState, toRequest } from "../lib/sandbox";
import { checkerSteps } from "./checkerSteps";
import { Editor } from "./Editor";
import { checkerGraph } from "./graphs";
import type { Route } from "./route";
import { Workbench } from "./Workbench";
import type { AppName } from "./route";

function stateFromKey(key: string): SandboxState {
	if (key.startsWith("edit.")) return decodeState(`#try=${key.slice(5)}`) ?? presetState(PRESETS[0].id);
	return presetState(key);
}

function keyFromState(st: SandboxState): string {
	const e = encodeState(st);
	const v = e.slice(4);
	return PRESETS.some((p) => p.id === v) ? v : `edit.${v}`;
}

export function CheckerApp({ route, setRoute, onApp, initial }: { route: Route; setRoute: (r: Route) => void; onApp: (a: AppName) => void; initial: Initial }) {
	const [load, setLoad] = useState<LoadState>(loadState());
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [attempt, setAttempt] = useState(1);
	const [max, setMax] = useState(2);
	const st = useMemo(() => stateFromKey(route.key), [route.key]);
	const preset = PRESETS.find((p) => p.id === (route.key.startsWith("edit.") ? "" : route.key)) ?? null;
	const edited = route.key.startsWith("edit.");
	const [draft, setDraft] = useState<SandboxState | null>(null);
	const base = useRef(PRESETS[0].id);
	const editing = useRef(false);
	if (preset) base.current = preset.id;
	const live = draft ?? st;

	useEffect(() => {
		setLoad(loadState());
		const off = onLoadState(setLoad);
		void ensureChecker().catch(() => undefined);
		return off;
	}, []);

	const [result, browserTimed] = useMemo((): [CheckResponse | null, boolean] => {
		if (load === "ready") return [runCheck(toRequest(live)), true];
		if (preset && !draft && initial[preset.id]) return [initial[preset.id], false];
		return [null, false];
	}, [load, live, preset, draft, initial]);

	const steps = useMemo(() => {
		if (!result) return null;
		return checkerSteps({
			message: live.message,
			prompt: preset?.prompt ?? "Your own case.",
			evidence: evidenceFromRows(live.rows),
			result,
			browserTimed,
			gate: route.gate,
			attempt: Math.min(attempt, max),
			max,
		});
	}, [result, browserTimed, live, preset, route.gate, attempt, max]);

	const change = (next: SandboxState) => {
		editing.current = true;
		setDraft(next);
		const pristine = preset ? sameState(next, presetState(preset.id)) : false;
		setRoute({ ...route, key: pristine && preset ? preset.id : keyFromState({ ...next, preset: null }) });
	};

	useEffect(() => {
		if (editing.current) {
			editing.current = false;
			return;
		}
		setDraft(null);
	}, [route.key]);

	const share = () => {
		navigator.clipboard
			.writeText(window.location.href)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1600);
			})
			.catch(() => undefined);
	};

	const controls = (
		<>
			<label className="wb__field">
				<span>Scenario</span>
				<select
					value={preset ? preset.id : "edited"}
					onChange={(e) => {
						if (e.target.value !== "edited") setRoute({ ...route, key: e.target.value, step: 0 });
					}}
				>
					{preset ? null : <option value="edited">Edited case</option>}
					{PRESETS.map((p) => (
						<option key={p.id} value={p.id}>
							{p.title}
						</option>
					))}
				</select>
			</label>
			<div className="wb__field">
				<span>Gate</span>
				<div className="wb__seg" role="group" aria-label="Gate mode">
					<button type="button" aria-pressed={route.gate} onClick={() => setRoute({ ...route, gate: true })}>
						On
					</button>
					<button type="button" aria-pressed={!route.gate} onClick={() => setRoute({ ...route, gate: false })}>
						Off
					</button>
				</div>
			</div>
			<label className="wb__field">
				<span>Attempt</span>
				<select value={Math.min(attempt, max)} onChange={(e) => setAttempt(Number(e.target.value))}>
					{[1, 2, 3].map((n) => (
						<option key={n} value={n} disabled={n > max}>
							{n}
						</option>
					))}
				</select>
			</label>
			<label className="wb__field">
				<span>of at most</span>
				<select value={max} onChange={(e) => setMax(Number(e.target.value))}>
					{[1, 2, 3].map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</select>
			</label>
			<button type="button" className="btn btn--primary wb__btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				Edit evidence
			</button>
		</>
	);

	const status =
		load === "failed" ? (
			<span className="wb__bad">The checker could not load. Showing recorded results where they exist.</span>
		) : load === "ready" ? (
			<span className="wb__live">
				<i aria-hidden="true" /> Go checker running in this tab
			</span>
		) : (
			<span>Loading the Go checker, about 1 MB</span>
		);

	if (!steps) {
		return (
			<div className="wb wb--wait">
				<p>Loading the Go checker. It runs in your tab as WebAssembly.</p>
			</div>
		);
	}

	return (
		<Workbench
			app="checker"
			onApp={onApp}
			path="final message, claim splitter, evidence, rule, verdict, gate, feedback or merge"
			controls={controls}
			status={status}
			graph={checkerGraph}
			steps={steps}
			step={route.step}
			onStep={(n) => setRoute({ ...route, step: n })}
			graphLabel="One agent turn through the Ledger checker and the fleet gate"
			drawer={
				open ? (
					<Editor
						state={live}
						onChange={change}
						onReset={() => setRoute({ ...route, key: base.current })}
						onClose={() => setOpen(false)}
						onShare={share}
						copied={copied}
						edited={edited}
					/>
				) : null
			}
		/>
	);
}

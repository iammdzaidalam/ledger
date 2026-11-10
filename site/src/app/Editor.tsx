import { useId, useRef, useState } from "react";
import { RowEditor } from "../components/RowEditor";
import type { EvidenceEntry } from "../lib/checker";
import { evidenceFromRows, nextRef, type Row, rowsFromEvidence, type SandboxState } from "../lib/sandbox";

export function Editor({
	state,
	onChange,
	onReset,
	onClose,
	onShare,
	copied,
	edited,
}: {
	state: SandboxState;
	onChange: (next: SandboxState) => void;
	onReset: () => void;
	onClose: () => void;
	onShare: () => void;
	copied: boolean;
	edited: boolean;
}) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const [json, setJson] = useState<{ on: boolean; text: string; error: string }>({ on: false, text: "", error: "" });
	const counter = useRef(0);
	const id = useId();

	const setRows = (fn: (rows: Row[]) => Row[]) => onChange({ ...state, rows: fn(state.rows) });
	const add = (tool: "Bash" | "Write" | "Edit") => {
		counter.current += 1;
		const base = { id: `n${Date.now()}${counter.current}`, ref: nextRef(state.rows), tool, exit: "0", failed: false, ran: true, stderr: "", diff: "" };
		const row: Row =
			tool === "Bash"
				? { ...base, target: "npm test", stdout: "" }
				: { ...base, target: "src/index.ts", stdout: "Wrote 120 bytes to src/index.ts", diff: "@@ -1,1 +1,2 @@\n+export const ready = true;" };
		setOpen((o) => ({ ...o, [row.id]: true }));
		setRows((rows) => [...rows, row]);
	};

	const onJson = (text: string) => {
		try {
			const parsed = JSON.parse(text) as EvidenceEntry[];
			if (!Array.isArray(parsed)) throw new Error("The evidence must be an array of calls.");
			const rows = rowsFromEvidence(
				parsed.map((e, i) => ({
					ref: e.ref ?? `c${i + 1}`,
					seq: i + 1,
					tool: e.tool ?? "Bash",
					args: e.args ?? {},
					raw_stdout: e.raw_stdout ?? "",
					raw_stderr: e.raw_stderr ?? "",
					exit_code: e.exit_code ?? null,
					executed: e.executed ?? true,
					is_error: e.is_error ?? false,
					duration_ms: e.duration_ms ?? 0,
					diff: e.diff ?? "",
				})),
				"j",
			);
			onChange({ ...state, rows });
			setJson({ on: true, text, error: "" });
		} catch (error) {
			setJson({ on: true, text, error: error instanceof Error ? error.message : "Invalid JSON" });
		}
	};

	return (
		<section className="ed" aria-label="Edit evidence">
			<div className="ed__head">
				<h2>Edit evidence</h2>
				<button type="button" className="ed__x" onClick={onClose} aria-label="Close the editor">
					<svg viewBox="0 0 12 12" aria-hidden="true">
						<path d="m3 3 6 6M9 3 3 9" />
					</svg>
				</button>
			</div>
			<p className="ed__note">Change the tool calls or the reply and the graph runs again, with the real checker, in your tab.</p>
			<div className="ed__tools">
				<button type="button" onClick={() => add("Bash")}>+ Bash</button>
				<button type="button" onClick={() => add("Write")}>+ Write</button>
				<button type="button" onClick={() => add("Edit")}>+ Edit</button>
				<button
					type="button"
					aria-pressed={json.on}
					onClick={() => (json.on ? setJson({ on: false, text: "", error: "" }) : setJson({ on: true, text: JSON.stringify(evidenceFromRows(state.rows), null, 2), error: "" }))}
				>
					{json.on ? "Rows" : "JSON"}
				</button>
			</div>
			<div className="ed__body">
				{json.on ? (
					<label className="ed__json">
						<span className="sb-label">Evidence as JSON</span>
						<textarea value={json.text} spellCheck={false} onChange={(e) => onJson(e.target.value)} aria-invalid={json.error !== ""} />
						{json.error ? (
							<span role="alert" className="sb-error">
								{json.error}
							</span>
						) : null}
					</label>
				) : state.rows.length === 0 ? (
					<p className="sb-empty">No tool calls recorded. Every claim about a run or a file will be unsupported.</p>
				) : (
					<ul className="sb-rows">
						{state.rows.map((r) => (
							<RowEditor
								key={r.id}
								row={r}
								open={Boolean(open[r.id])}
								active={false}
								onToggle={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
								onChange={(patch) => setRows((rows) => rows.map((x) => (x.id === r.id ? { ...x, ...patch } : x)))}
								onRemove={() => setRows((rows) => rows.filter((x) => x.id !== r.id))}
							/>
						))}
					</ul>
				)}
				<label className="ed__msg" htmlFor={`${id}-m`}>
					<span className="sb-label">What the agent said</span>
					<textarea id={`${id}-m`} value={state.message} rows={5} spellCheck={false} onChange={(e) => onChange({ ...state, message: e.target.value })} />
				</label>
			</div>
			<div className="ed__foot">
				<button type="button" onClick={onReset} disabled={!edited}>
					Reset to the recorded case
				</button>
				<button type="button" onClick={onShare}>
					{copied ? "Link copied" : "Copy link"}
				</button>
			</div>
		</section>
	);
}

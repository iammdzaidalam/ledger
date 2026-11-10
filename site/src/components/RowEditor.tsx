import { useId } from "react";
import { type Row, TOOLS } from "../lib/sandbox";

export function RowEditor({
	row,
	open,
	active,
	onToggle,
	onChange,
	onRemove,
}: {
	row: Row;
	open: boolean;
	active: boolean;
	onToggle: () => void;
	onChange: (patch: Partial<Row>) => void;
	onRemove: () => void;
}) {
	const id = useId();
	const bash = row.tool === "Bash";
	return (
		<li className={`sb-row${active ? " is-active" : ""}${open ? " is-open" : ""}`} data-ref={row.ref}>
			<div className="sb-row__bar">
				<span className="sb-ref">{row.ref}</span>
				<select aria-label={`Tool for ${row.ref}`} value={row.tool} onChange={(e) => onChange({ tool: e.target.value })}>
					{TOOLS.map((t) => (
						<option key={t}>{t}</option>
					))}
				</select>
				<input
					aria-label={`${bash ? "Command" : "Path"} for ${row.ref}`}
					className="sb-row__target"
					value={row.target}
					spellCheck={false}
					placeholder={bash ? "npm test" : "src/file.ts"}
					onChange={(e) => onChange({ target: e.target.value })}
				/>
				{bash ? (
					<label className="sb-exit" htmlFor={`${id}-x`}>
						<span>exit</span>
						<input
							id={`${id}-x`}
							type="number"
							inputMode="numeric"
							value={row.exit}
							disabled={!row.ran}
							onChange={(e) => onChange({ exit: e.target.value })}
						/>
					</label>
				) : (
					<select aria-label={`Result of ${row.ref}`} value={row.failed ? "failed" : "ok"} onChange={(e) => onChange({ failed: e.target.value === "failed" })}>
						<option value="ok">ok</option>
						<option value="failed">failed</option>
					</select>
				)}
				<button type="button" className="sb-icon" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} output of ${row.ref}`} onClick={onToggle}>
					<svg viewBox="0 0 12 12" aria-hidden="true">
						<path d="M2.5 4.5 6 8l3.5-3.5" />
					</svg>
				</button>
				<button type="button" className="sb-icon sb-icon--del" aria-label={`Remove ${row.ref}`} onClick={onRemove}>
					<svg viewBox="0 0 12 12" aria-hidden="true">
						<path d="m3 3 6 6M9 3 3 9" />
					</svg>
				</button>
			</div>
			{open ? (
				<div className="sb-row__more">
					<label>
						<span className="sb-label">stdout</span>
						<textarea value={row.stdout} rows={3} spellCheck={false} onChange={(e) => onChange({ stdout: e.target.value })} />
					</label>
					<label>
						<span className="sb-label">stderr</span>
						<textarea value={row.stderr} rows={2} spellCheck={false} onChange={(e) => onChange({ stderr: e.target.value })} />
					</label>
					{!bash ? (
						<label>
							<span className="sb-label">diff (empty means no change was recorded)</span>
							<textarea value={row.diff} rows={3} spellCheck={false} onChange={(e) => onChange({ diff: e.target.value })} />
						</label>
					) : null}
					<label className="sb-check">
						<input type="checkbox" checked={!row.ran} onChange={(e) => onChange({ ran: !e.target.checked })} />
						Never ran (timed out or did not start)
					</label>
				</div>
			) : null}
		</li>
	);
}


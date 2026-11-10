export type Verdict = "verified" | "contradicted" | "unsupported" | "unverifiable";

export interface ClaimResult {
	text: string;
	kind: string;
	ref?: string;
	attribution: string;
	verdict: Verdict;
	rule: string;
	reason: string;
}

export interface CheckResponse {
	request_id?: string;
	claims: ClaimResult[];
	error?: string;
	latency_us: number;
	flagged: boolean;
	changed_files: boolean;
}

export interface EvidenceEntry {
	ref: string;
	seq: number;
	tool: string;
	args: Record<string, unknown>;
	raw_stdout: string;
	raw_stderr: string;
	exit_code: number | null;
	executed: boolean;
	is_error: boolean;
	duration_ms: number;
	diff?: string;
}

export interface CheckRequest {
	request_id?: string;
	turn_text: string;
	evidence: EvidenceEntry[];
	fresh_refs: string[];
}

type CheckFn = (input: string) => string;

declare global {
	interface Window {
		Go?: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
		ledgerCheck?: CheckFn;
	}
}

export type LoadState = "idle" | "loading" | "ready" | "failed";

let state: LoadState = "idle";
let pending: Promise<void> | null = null;
const listeners = new Set<(s: LoadState) => void>();

function set(next: LoadState): void {
	state = next;
	for (const l of listeners) l(next);
}

export function loadState(): LoadState {
	return state;
}

export function onLoadState(fn: (s: LoadState) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function script(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const el = document.createElement("script");
		el.src = src;
		el.onload = () => resolve();
		el.onerror = () => reject(new Error(`could not load ${src}`));
		document.head.append(el);
	});
}

export function ensureChecker(): Promise<void> {
	if (typeof window === "undefined") return Promise.resolve();
	if (pending) return pending;
	set("loading");
	pending = (async () => {
		await script("wasm_exec.js");
		if (!window.Go) throw new Error("wasm_exec.js did not define Go");
		const go = new window.Go();
		const url = "ledger.wasm";
		let instance: WebAssembly.Instance;
		try {
			({ instance } = await WebAssembly.instantiateStreaming(fetch(url), go.importObject));
		} catch {
			const bytes = await (await fetch(url)).arrayBuffer();
			({ instance } = await WebAssembly.instantiate(bytes, go.importObject));
		}
		void go.run(instance);
		for (let i = 0; i < 100 && !window.ledgerCheck; i++) await new Promise((r) => setTimeout(r, 10));
		if (!window.ledgerCheck) throw new Error("the checker did not start");
		window.ledgerCheck(JSON.stringify({ turn_text: "warm up", evidence: [], fresh_refs: [] }));
		set("ready");
	})().catch((error) => {
		set("failed");
		pending = null;
		throw error;
	});
	return pending;
}

export function runCheck(req: CheckRequest): CheckResponse | null {
	const fn: CheckFn | undefined = typeof window === "undefined" ? (globalThis as { ledgerCheck?: CheckFn }).ledgerCheck : window.ledgerCheck;
	if (!fn) return null;
	return JSON.parse(fn(JSON.stringify(req))) as CheckResponse;
}

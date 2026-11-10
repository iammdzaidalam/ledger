import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, type Badge, type Cat, type GEdge, type GNode, type Graph } from "./types";

const COLOURS: Record<Cat, string> = {
	input: "#ff6a26",
	data: "#b9d3cd",
	logic: "#d8d3c6",
	decision: "#e8b24a",
	store: "#8fa8c8",
	good: "#7fcf9f",
	bad: "#ff5a3c",
};

const TONES = { ok: "#7fcf9f", bad: "#ff5a3c", warn: "#e8b24a", info: "#a3aba8" };

interface View {
	x: number;
	y: number;
	k: number;
}

function anchor(n: GNode, side: "l" | "r" | "t" | "b"): [number, number] {
	if (side === "l") return [n.x, n.y + n.h / 2];
	if (side === "r") return [n.x + n.w, n.y + n.h / 2];
	if (side === "t") return [n.x + n.w / 2, n.y];
	return [n.x + n.w / 2, n.y + n.h];
}

function edgeGeometry(a: GNode, b: GNode): { d: string; mid: [number, number] } {
	const ax = a.x + a.w / 2;
	const bx = b.x + b.w / 2;
	const ay = a.y + a.h / 2;
	const by = b.y + b.h / 2;
	const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay) * 0.9;
	let p: [number, number];
	let q: [number, number];
	let d: string;
	if (horizontal) {
		p = anchor(a, bx >= ax ? "r" : "l");
		q = anchor(b, bx >= ax ? "l" : "r");
		const c = Math.max(40, Math.abs(q[0] - p[0]) / 2);
		const s = bx >= ax ? 1 : -1;
		d = `M${p[0]} ${p[1]} C${p[0] + c * s} ${p[1]} ${q[0] - c * s} ${q[1]} ${q[0]} ${q[1]}`;
	} else {
		p = anchor(a, by >= ay ? "b" : "t");
		q = anchor(b, by >= ay ? "t" : "b");
		const c = Math.max(30, Math.abs(q[1] - p[1]) / 2);
		const s = by >= ay ? 1 : -1;
		d = `M${p[0]} ${p[1]} C${p[0]} ${p[1] + c * s} ${q[0]} ${q[1] - c * s} ${q[0]} ${q[1]}`;
	}
	return { d, mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] };
}

function useReduced(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		const m = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(m.matches);
		const on = () => setReduced(m.matches);
		m.addEventListener("change", on);
		return () => m.removeEventListener("change", on);
	}, []);
	return reduced;
}

export function Canvas({
	graph,
	activeNodes,
	activeEdges,
	visited,
	badges,
	playing,
	label,
}: {
	graph: Graph;
	activeNodes: Set<string>;
	activeEdges: Set<string>;
	visited: Set<string>;
	badges: Record<string, Badge>;
	playing: boolean;
	label: string;
}) {
	const wrap = useRef<HTMLDivElement | null>(null);
	const moved = useRef(false);
	const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
	const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
	const reduced = useReduced();
	const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
	const bounds = useMemo(() => {
		const xs = graph.nodes.flatMap((n) => [n.x, n.x + n.w]);
		const ys = graph.nodes.flatMap((n) => [n.y - 14, n.y + n.h]);
		return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
	}, [graph]);

	const fit = useCallback(() => {
		const el = wrap.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return;
		const small = r.width < 600;
		const pad = small ? 16 : 56;
		const top = small ? 16 : 96;
		const bottom = small ? 16 : 72;
		const k = Math.min((r.width - pad * 2) / bounds.w, (r.height - top - bottom) / bounds.h, 1.5);
		setView({ k, x: (r.width - bounds.w * k) / 2 - bounds.x * k, y: top + (r.height - top - bottom - bounds.h * k) / 2 - bounds.y * k });
		moved.current = false;
	}, [bounds]);

	const activeKey = [...activeNodes].join("|");
	const follow = useCallback(() => {
		const el = wrap.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		if (r.width === 0) return;
		const nodes = graph.nodes.filter((n) => activeNodes.has(n.id));
		if (nodes.length === 0) return;
		const x0 = Math.min(...nodes.map((n) => n.x));
		const x1 = Math.max(...nodes.map((n) => n.x + n.w));
		const y0 = Math.min(...nodes.map((n) => n.y));
		const y1 = Math.max(...nodes.map((n) => n.y + n.h));
		const k = Math.min(0.9, (r.width - 32) / (x1 - x0 + 60), (r.height - 40) / (y1 - y0 + 60));
		setView({ k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k });
		moved.current = false;
	}, [graph, activeKey]);

	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const tiny = () => {
			const r = el.getBoundingClientRect();
			return Math.min((r.width - 32) / bounds.w, (r.height - 40) / bounds.h) < 0.5;
		};
		if (tiny()) follow();
		else fit();
		const ro = new ResizeObserver(() => {
			if (tiny()) follow();
			else if (!moved.current) fit();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [fit, follow, bounds]);

	const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
		moved.current = true;
		setView((v) => {
			const k = Math.min(3, Math.max(0.25, v.k * factor));
			const f = k / v.k;
			return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
		});
	}, []);

	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = el.getBoundingClientRect();
			zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [zoomAt]);

	const center = (factor: number) => {
		const r = wrap.current?.getBoundingClientRect();
		if (r) zoomAt(r.width / 2, r.height / 2, factor);
	};

	const pulse = playing && !reduced;
	return (
		<div className="cv" ref={wrap}>
			<svg
				className="cv__svg"
				role="img"
				aria-label={label}
				onPointerDown={(e) => {
					(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
					drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
				}}
				onPointerMove={(e) => {
					const d = drag.current;
					if (!d) return;
					moved.current = true;
					setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
				}}
				onPointerUp={() => {
					drag.current = null;
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
			>
				<defs>
					<marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M0 0 10 5 0 10z" fill="#566" />
					</marker>
					<marker id="cv-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M0 0 10 5 0 10z" fill="#ff6a26" />
					</marker>
				</defs>
				<g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
					{graph.edges.map((e: GEdge) => {
						const a = byId.get(e.from);
						const b = byId.get(e.to);
						if (!a || !b) return null;
						const g = edgeGeometry(a, b);
						const on = activeEdges.has(e.id);
						const seen = visited.has(a.id) && visited.has(b.id);
						return (
							<g key={e.id} className={`cv-edge${on ? " is-on" : ""}${seen ? " is-seen" : ""}`}>
								<path d={g.d} markerEnd={on ? "url(#cv-arrow-on)" : "url(#cv-arrow)"} />
								{e.label ? (
									<text x={g.mid[0]} y={g.mid[1] - 6} textAnchor="middle">
										{e.label}
									</text>
								) : null}
								{on && pulse ? (
									<circle r="4.5" className="cv-pulse">
										<animateMotion dur="1.3s" repeatCount="indefinite" path={g.d} />
									</circle>
								) : null}
							</g>
						);
					})}
					{graph.nodes.map((n) => {
						const on = activeNodes.has(n.id);
						const seen = visited.has(n.id);
						const badge = badges[n.id];
						const colour = COLOURS[n.cat];
						const bw = badge ? Math.min(n.w + 40, badge.text.length * 6.4 + 16) : 0;
						return (
							<g key={n.id} className={`cv-node${on ? " is-on" : ""}${seen ? " is-seen" : ""}`} transform={`translate(${n.x} ${n.y})`}>
								<rect width={n.w} height={n.h} rx="10" fill="#171c1b" stroke={colour} strokeWidth={on ? 2.5 : 1.2} />
								<rect width="5" height={n.h} rx="2.5" fill={colour} />
								<text x="16" y={n.sub ? 24 : n.h / 2 + 5} className="cv-label">
									{n.label}
								</text>
								{(n.sub ?? []).map((s, i) => (
									<text key={s} x="16" y={42 + i * 15} className="cv-sub">
										{s}
									</text>
								))}
								{badge ? (
									<g transform={`translate(${n.w - bw + 8} ${-12})`} className="cv-badge">
										<rect width={bw} height="20" rx="10" fill="#0e1110" stroke={TONES[badge.tone]} />
										<text x={bw / 2} y="14" textAnchor="middle" fill={TONES[badge.tone]}>
											{badge.text.length * 6.4 + 16 > n.w + 40 ? `${badge.text.slice(0, Math.floor((n.w + 24) / 6.4))}...` : badge.text}
										</text>
									</g>
								) : null}
							</g>
						);
					})}
				</g>
			</svg>
			<div className="cv__tools" role="group" aria-label="Canvas view">
				<button type="button" onClick={fit} aria-label="Fit the graph to the view">
					Fit
				</button>
				<button type="button" onClick={() => center(1.2)} aria-label="Zoom in">
					+
				</button>
				<button type="button" onClick={() => center(1 / 1.2)} aria-label="Zoom out">
					-
				</button>
			</div>
			<ul className="cv__legend" aria-label="Legend">
				{CATEGORIES.map((c) => (
					<li key={c.cat}>
						<i style={{ background: COLOURS[c.cat] }} />
						{c.label}
					</li>
				))}
			</ul>
			<p className="cv__hint">Drag to pan, scroll to zoom</p>
		</div>
	);
}

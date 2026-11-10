export type Cat = "input" | "data" | "logic" | "decision" | "store" | "good" | "bad";
export type Tone = "ok" | "bad" | "warn" | "info";

export interface GNode {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	label: string;
	sub?: string[];
	cat: Cat;
}

export interface GEdge {
	id: string;
	from: string;
	to: string;
	label?: string;
}

export interface Graph {
	nodes: GNode[];
	edges: GEdge[];
}

export interface Badge {
	text: string;
	tone: Tone;
}

export interface AppStep {
	phase: string;
	title: string;
	desc: string;
	src: string | null;
	nodes: string[];
	edges: string[];
	payload: unknown;
	messages: { label: string; text: string }[];
	events: { type: string; text: string }[];
	badges: Record<string, Badge>;
}

export const CATEGORIES: { cat: Cat; label: string }[] = [
	{ cat: "input", label: "Agent and goal" },
	{ cat: "data", label: "Recorded data" },
	{ cat: "logic", label: "Checker and workers" },
	{ cat: "decision", label: "Decision" },
	{ cat: "store", label: "Storage and events" },
	{ cat: "good", label: "Merged" },
	{ cat: "bad", label: "Stopped" },
];

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Provider } from "../providers/types.js";
import type { SubtaskSpec } from "./types.js";

const run = promisify(execFile);

const FILE_CAP = 400;
const TITLE_CAP = 72;

export function plannerSystem(max: number): string {
	return `You split a coding goal into subtasks that separate coding agents will do at the same time, each in its own copy of the repository.

Split only when the pieces touch different files and can be done in any order. If the goal is small, or the pieces would edit the same files, or one piece needs another's result, return a single subtask.

Return at most ${max} subtasks. Each prompt must stand alone and name the files or directories to change.

Reply with a JSON array and nothing else: [{"title": "short name", "prompt": "full instructions"}]`;
}

export function plannerMessage(goal: string, files: string[]): string {
	const listed = files.slice(0, FILE_CAP).join("\n");
	const more = files.length > FILE_CAP ? `\n(${files.length - FILE_CAP} more files not shown)` : "";
	return `Goal:\n${goal}\n\nFiles in the repository:\n${listed}${more}`;
}

function arrayEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "[") depth++;
		else if (ch === "]" && --depth === 0) return i;
	}
	return -1;
}

export function firstJsonArray(text: string): unknown[] | undefined {
	for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
		const end = arrayEnd(text, start);
		if (end < 0) continue;
		try {
			const parsed: unknown = JSON.parse(text.slice(start, end + 1));
			if (Array.isArray(parsed) && parsed.some((item) => item && typeof item === "object")) return parsed;
		} catch {}
	}
	return undefined;
}

function titleFrom(prompt: string): string {
	const line = prompt.split("\n")[0]?.trim() ?? "";
	return line.length > TITLE_CAP ? `${line.slice(0, TITLE_CAP - 3)}...` : line;
}

export function parseSubtasks(text: string, max: number): SubtaskSpec[] {
	const items = firstJsonArray(text) ?? [];
	const seen = new Set<string>();
	const out: SubtaskSpec[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const { title, prompt } = item as { title?: unknown; prompt?: unknown };
		if (typeof prompt !== "string" || !prompt.trim()) continue;
		const body = prompt.trim();
		const name = typeof title === "string" && title.trim() ? title.trim() : titleFrom(body);
		const keys = [name.toLowerCase(), body.toLowerCase()];
		if (keys.some((key) => seen.has(key))) continue;
		for (const key of keys) seen.add(key);
		out.push({ title: name, prompt: body });
		if (out.length >= max) break;
	}
	return out;
}

export function singleSubtask(goal: string): SubtaskSpec[] {
	return [{ title: titleFrom(goal) || "goal", prompt: goal }];
}

export function planFromText(goal: string, text: string, max: number): SubtaskSpec[] {
	const parsed = parseSubtasks(text, max);
	return parsed.length > 1 ? parsed : singleSubtask(goal);
}

export async function listRepoFiles(repo: string): Promise<string[]> {
	try {
		const { stdout } = await run("git", ["ls-files"], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
		return stdout.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export interface PlanOptions {
	goal: string;
	files: string[];
	provider: Provider;
	model: string;
	max: number;
	signal?: AbortSignal;
}

export async function planSubtasks(options: PlanOptions): Promise<SubtaskSpec[]> {
	if (options.max <= 1) return singleSubtask(options.goal);
	let text = "";
	try {
		for await (const event of options.provider.complete({
			model: options.model,
			system: plannerSystem(options.max),
			messages: [{ role: "user", content: plannerMessage(options.goal, options.files) }],
			tools: [],
			max_tokens: 1500,
			temperature: 0,
			signal: options.signal,
		})) {
			if (event.type === "text_delta") text += event.delta;
		}
	} catch {
		return singleSubtask(options.goal);
	}
	return planFromText(options.goal, text, options.max);
}

import { describeRule } from "../permissions/rules.js";
import type { Asker, PermissionAnswer, PermissionRequest } from "../permissions/types.js";

export interface PendingPermission {
	id: number;
	request: PermissionRequest;
	rules: string[];
}

type Listener = () => void;

export class PermissionQueue {
	private items: Array<PendingPermission & { resolve: (answer: PermissionAnswer) => void }> = [];
	private listeners = new Set<Listener>();
	private nextId = 1;

	readonly ask: Asker = (request, rules) =>
		new Promise<PermissionAnswer>((resolve) => {
			this.items.push({ id: this.nextId++, request, rules, resolve });
			this.emit();
		});

	current = (): PendingPermission | undefined => this.items[0];

	subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	answer(answer: PermissionAnswer): void {
		const item = this.items.shift();
		if (!item) return;
		item.resolve(answer);
		this.emit();
	}

	denyAll(reason: string): void {
		const items = this.items;
		if (items.length === 0) return;
		this.items = [];
		for (const item of items) item.resolve({ kind: "deny", reason });
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export type Choice = "once" | "session" | "deny";

export function choiceForKey(input: string): Choice | null {
	const k = input.toLowerCase();
	if (k === "y") return "once";
	if (k === "a") return "session";
	if (k === "n") return "deny";
	return null;
}

export function answerFor(choice: Exclude<Choice, "deny">, rules: string[]): PermissionAnswer {
	return choice === "session" && rules.length > 0 ? { kind: "session" } : { kind: "once" };
}

export function scopeText(rules: string[]): string {
	return rules.map(describeRule).join(", ");
}

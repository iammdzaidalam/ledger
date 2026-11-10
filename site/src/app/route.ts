import { PRESETS } from "../lib/sandbox";

export type AppName = "checker" | "swarm";

export interface Route {
	app: AppName;
	key: string;
	gate: boolean;
	step: number;
}

export const DEFAULT_ROUTE: Route = { app: "checker", key: PRESETS[0].id, gate: true, step: 0 };

export function parseRoute(hash: string, runCount: number): Route {
	const raw = hash.replace(/^#/, "");
	if (raw.startsWith("try=")) return { app: "checker", key: PRESETS.some((p) => p.id === raw.slice(4)) ? raw.slice(4) : `edit.${raw.slice(4)}`, gate: true, step: 0 };
	const [app, key, gate, step] = raw.split("/");
	const n = Number.parseInt(step ?? "", 10);
	const index = Number.isFinite(n) && n >= 0 ? n : 0;
	if (app === "swarm") {
		const run = Number.parseInt(key ?? "", 10);
		return { app: "swarm", key: String(run >= 1 && run <= runCount ? run : 1), gate: gate !== "off", step: index };
	}
	if (app === "checker") {
		const valid = key && (PRESETS.some((p) => p.id === key) || key.startsWith("edit."));
		return { app: "checker", key: valid ? key : DEFAULT_ROUTE.key, gate: gate !== "off", step: index };
	}
	return DEFAULT_ROUTE;
}

export function formatRoute(r: Route): string {
	return `#${r.app}/${r.key}/${r.gate ? "on" : "off"}/${r.step}`;
}

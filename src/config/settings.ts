import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Settings } from "./types.js";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".ledger", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".ledger", "settings.json");

async function readJsonIfExists(path: string): Promise<Settings> {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw) as Settings;
	} catch {
		return {};
	}
}

// Global -> project -> env, each one overriding the last.
export async function loadSettings(): Promise<Settings> {
	const global = await readJsonIfExists(GLOBAL_SETTINGS_PATH);
	const project = await readJsonIfExists(PROJECT_SETTINGS_PATH);

	const merged: Settings = { ...global, ...project };

	if (process.env.LEDGER_PROVIDER) merged.provider = process.env.LEDGER_PROVIDER;
	if (process.env.LEDGER_MODEL) merged.model = process.env.LEDGER_MODEL;

	return merged;
}

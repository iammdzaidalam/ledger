import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entryPoint, ledgerLauncher } from "../src/swarm/child.js";

describe("child launcher", () => {
	it("builds the print command with the run id and server in the environment", () => {
		const spec = ledgerLauncher({
			cwd: "/w",
			prompt: "do it",
			runId: "run-1",
			provider: "ollama",
			model: "qwen2.5:7b",
			server: "http://s:1",
		});
		expect(spec.args.slice(-13)).toEqual([
			"--print",
			"--yes",
			"--validate",
			"strict",
			"--claims",
			"prose",
			"--provider",
			"ollama",
			"--model",
			"qwen2.5:7b",
			"--session",
			"run-1",
			"do it",
		]);
		expect(spec.env.LEDGER_SERVER).toBe("http://s:1");
		expect(spec.env.LEDGER_RUN_ID).toBe("run-1");
	});

	it("finds the source entry through tsx from src and the built entry from dist", () => {
		const source = entryPoint(join(import.meta.dirname, "..", "src", "swarm"));
		expect(source.file.endsWith(join("src", "index.ts"))).toBe(true);
		expect(source.execArgv[0]).toBe("--import");
		const built = entryPoint(join(import.meta.dirname, "..", "dist", "swarm"));
		expect(built.file.endsWith(join("dist", "index.js"))).toBe(true);
		expect(built.execArgv).toEqual([]);
	});

	it("starts the real entry point from another directory", () => {
		const spec = ledgerLauncher({
			cwd: "/",
			prompt: "",
			runId: "r",
			provider: "ollama",
			model: "m",
			server: "http://s",
		});
		const entry = entryPoint();
		const out = execFileSync(process.execPath, [...entry.execArgv, entry.file, "--version"], {
			cwd: "/",
			encoding: "utf-8",
		});
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(spec.command).toBe(process.execPath);
	});
});

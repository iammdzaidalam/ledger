import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/types.js";
import type { ReplState } from "../src/commands/registry.js";
import type { GroundingClient } from "../src/grounding/client.js";
import type { TurnSettings } from "../src/modes/turn.js";
import { createPolicy } from "../src/permissions/policy.js";
import { ActiveSession } from "../src/session/active.js";
import { App, type RunTurn } from "../src/tui/app.js";
import { PermissionQueue } from "../src/tui/permission.js";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
	const stop = Date.now() + ms;
	while (!check()) {
		if (Date.now() > stop) throw new Error("timed out waiting for the frame");
		await tick(10);
	}
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ledger-tui-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function setup(run: RunTurn, options: { permissions?: PermissionQueue } = {}) {
	const repl: ReplState = {
		session: ActiveSession.create("tui-test", "ollama", "qwen2.5:7b", dir),
		cwd: dir,
	};
	const permissions = options.permissions ?? new PermissionQueue();
	const turn: TurnSettings = {
		system: "",
		validate: "revise",
		permissions: createPolicy(undefined, false, permissions.ask),
	};
	const app = render(
		<App
			repl={repl}
			turn={turn}
			groundingClient={{} as GroundingClient}
			permissions={permissions}
			resumed={false}
			color={false}
			run={run}
			size={{ columns: 100, rows: 30 }}
		/>,
	);
	return { app, repl, permissions };
}

const frame = (app: ReturnType<typeof render>) => app.lastFrame() ?? "";

describe("tui app", () => {
	it("streams a reply, marks the false claim inline and shows the ledger", async () => {
		const run: RunTurn = async (_session, _input, _settings, _client, onEvent) => {
			const claim = {
				text: "All tests pass.",
				kind: "tests_pass" as const,
				ref: "c1",
				attribution: "family" as const,
				verdict: "contradicted" as const,
				rule: "r",
				reason: "`npm test` exited 1",
			};
			const events: AgentEvent[] = [
				{ type: "agent_start" },
				{ type: "text_delta", delta: "I ran them. All tests pass." },
				{ type: "assistant_turn", turn: 1, text: "I ran them. All tests pass.", toolCalls: 0 },
				{ type: "grounding_check", turn: 1, claims: [claim], latencyMs: 2 },
				{ type: "grounding_flag", claim },
				{
					type: "agent_end",
					messages: [],
					ledger: {
						mode: "flag",
						entries: [
							{
								turn: 1,
								text: claim.text,
								kind: claim.kind,
								ref: "c1",
								firstVerdict: "contradicted",
								verdict: "contradicted",
								reason: claim.reason,
								status: "false",
								revisions: 0,
								newInRevision: false,
							},
						],
						revisionsRequested: 0,
						falseClaims: 1,
						checkerErrors: 0,
						unverified: true,
					},
				},
			];
			for (const e of events) onEvent(e);
			return undefined;
		};
		const { app } = setup(run);
		await tick();
		app.stdin.write("run the tests");
		await tick();
		app.stdin.write("\r");
		await until(() => frame(app).includes("Ledger"));
		const out = frame(app);
		expect(out).toContain("› run the tests");
		expect(out).toContain("All tests pass. [✗ CONTRADICTED c1: `npm test` exited 1]");
		expect(out).toMatch(/FALSE\s+t1 c1/);
		expect(out).toContain("claims 0✓ 1✗ 0?");
		app.unmount();
	});

	it("runs slash commands from the registry and prints into the transcript", async () => {
		const { app } = setup(async () => undefined);
		await tick();
		app.stdin.write("/ev");
		await tick();
		expect(frame(app)).toContain("/evidence");
		app.stdin.write("\r");
		await until(() => frame(app).includes("No evidence yet"));
		app.stdin.write("/help");
		await tick();
		app.stdin.write("\r");
		await until(() => frame(app).includes("List the commands"));
		app.unmount();
	});

	it("asks for permission in the UI and passes the reason back", async () => {
		let decision: unknown;
		const run: RunTurn = async (_session, _input, settings, _client, onEvent) => {
			onEvent({ type: "tool_start", id: "t1", name: "Bash", input: { command: "npm test" } });
			decision = await settings.permissions?.check({
				tool: "Bash",
				input: { command: "npm test" },
				summary: "npm test",
			});
			return undefined;
		};
		const { app } = setup(run);
		await tick();
		app.stdin.write("go");
		await tick();
		app.stdin.write("\r");
		await until(() => frame(app).includes("Allow Bash: npm test"));
		expect(frame(app)).toContain("yes, and allow `npm test` commands for the rest of this session");
		app.stdin.write("n");
		await until(() => frame(app).includes("Why not?"));
		app.stdin.write("flaky");
		await tick();
		app.stdin.write("\r");
		await until(() => decision !== undefined);
		expect(decision).toEqual({ allow: false, reason: "the user denied it (flaky)" });
		app.unmount();
	});

	it("cancels a run on Ctrl+C and keeps the session usable after a provider error", async () => {
		let calls = 0;
		const run: RunTurn = async (_session, _input, _settings, _client, _onEvent, signal) => {
			calls++;
			if (calls === 2) throw new Error("Could not reach Ollama at http://127.0.0.1:11434. Is it running?");
			await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
			return undefined;
		};
		const { app } = setup(run);
		await tick();
		app.stdin.write("slow one");
		await tick();
		app.stdin.write("\r");
		await until(() => frame(app).includes("working"));
		app.stdin.write("\u0003");
		await until(() => frame(app).includes("Cancelled."));
		app.stdin.write("again");
		await tick();
		app.stdin.write("\r");
		await until(() => frame(app).includes("Could not reach Ollama"));
		expect(frame(app)).toContain("› ");
		expect(frame(app)).not.toContain("working");
		app.unmount();
	});
});

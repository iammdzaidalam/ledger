import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import type { AgentEvent } from "../src/agent/types.js";
import { GroundingClient } from "../src/grounding/client.js";
import { EvidenceLog } from "../src/grounding/evidence.js";
import { NO_TERMINAL_REASON, PermissionPolicy } from "../src/permissions/policy.js";
import { terminalAsker } from "../src/permissions/prompt.js";
import { bashPrefixes, commandPrefix, ruleAllows, sessionRulesFor } from "../src/permissions/rules.js";
import type { Asker, PermissionAnswer, PermissionGate, PermissionRequest } from "../src/permissions/types.js";
import type { Message } from "../src/types.js";
import { type Step, scriptedProvider } from "./helpers.js";

const bash = (command: string): PermissionRequest => ({ tool: "Bash", input: { command }, summary: command });

describe("bash command prefixes", () => {
	it("keeps the subcommand for tools that have one", () => {
		expect(commandPrefix("npm test -- --watch")).toBe("npm test");
		expect(commandPrefix("npm run build:prod")).toBe("npm run build:prod");
		expect(commandPrefix("go test ./...")).toBe("go test");
		expect(commandPrefix("python3 -m pytest -q")).toBe("python3 -m pytest");
		expect(commandPrefix("CI=1 npx vitest run")).toBe("npx vitest");
		expect(commandPrefix("ls -la src")).toBe("ls");
		expect(commandPrefix("git --no-pager log")).toBe("git");
	});

	it("refuses to remember commands with substitution or file redirection", () => {
		expect(bashPrefixes("echo $(cat ~/.ssh/id_rsa)")).toBeUndefined();
		expect(bashPrefixes("echo `whoami`")).toBeUndefined();
		expect(bashPrefixes("echo hi > notes.txt")).toBeUndefined();
		expect(bashPrefixes("npm test 2>&1 | tail -5")).toEqual(["npm test", "tail"]);
		expect(bashPrefixes("go vet ./... > /dev/null")).toEqual(["go vet"]);
	});

	it("does not split on separators inside quotes", () => {
		expect(bashPrefixes("echo ' Tests 1 failed | 2 passed (3)'; exit 1")).toEqual(["echo", "exit"]);
		expect(bashPrefixes('git commit -m "fix: a; b && c"')).toEqual(["git commit"]);
		expect(bashPrefixes("echo 'a > b'")).toEqual(["echo"]);
		expect(bashPrefixes("grep -E 'x|y' src && npm test")).toEqual(["grep", "npm test"]);
		expect(bashPrefixes("echo 'unterminated")).toBeUndefined();
		expect(bashPrefixes('echo "$(whoami)"')).toBeUndefined();
	});

	it("needs every segment of a compound command to be allowed", () => {
		const rules = new Set(["Bash(npm test)"]);
		expect(ruleAllows(rules, bash("npm test -- --run"))).toBe(true);
		expect(ruleAllows(rules, bash("npm test && rm -rf build"))).toBe(false);
		expect(ruleAllows(rules, bash("npm run test"))).toBe(false);
		expect(ruleAllows(new Set(["Bash"]), bash("anything at all"))).toBe(true);
	});

	it("offers one rule per prefix for the session", () => {
		expect(sessionRulesFor(bash("npm run build && npm test"))).toEqual([
			"Bash(npm run build)",
			"Bash(npm test)",
		]);
		expect(sessionRulesFor({ tool: "Write", input: { path: "a" }, summary: "Write a" })).toEqual(["Write"]);
		expect(sessionRulesFor(bash("cat x > y"))).toEqual([]);
	});
});

describe("PermissionPolicy", () => {
	function answering(...answers: PermissionAnswer[]) {
		const state = { calls: 0 };
		const ask: Asker = async () => {
			state.calls++;
			return answers.shift() ?? { kind: "deny" };
		};
		return { ask, state };
	}

	it("allows everything with --yes and never asks", async () => {
		const { ask, state } = answering();
		const policy = new PermissionPolicy({ mode: "allow", ask });
		expect(await policy.check(bash("rm -rf build"))).toEqual({ allow: true });
		expect(state.calls).toBe(0);
	});

	it("asks each time for 'once' and remembers 'session' per bash prefix", async () => {
		const { ask, state } = answering({ kind: "once" }, { kind: "session" });
		const policy = new PermissionPolicy({ mode: "ask", ask });
		expect(await policy.check(bash("npm test"))).toEqual({ allow: true });
		expect(await policy.check(bash("npm test"))).toEqual({ allow: true });
		expect(state.calls).toBe(2);
		expect(await policy.check(bash("npm test -- --coverage"))).toEqual({ allow: true });
		expect(state.calls).toBe(2);
		expect(await policy.check(bash("npm install left-pad"))).toMatchObject({ allow: false });
		expect(state.calls).toBe(3);
	});

	it("passes the user's reason back on deny", async () => {
		const { ask } = answering({ kind: "deny", reason: "use pnpm here" });
		const policy = new PermissionPolicy({ mode: "ask", ask });
		const decision = await policy.check(bash("npm install"));
		expect(decision).toEqual({ allow: false, reason: "the user denied it (use pnpm here)" });
	});

	it("denies with a clear message when there is no terminal to ask", async () => {
		const denied: string[] = [];
		const policy = new PermissionPolicy({ mode: "ask", onDenied: (r) => denied.push(r.tool) });
		const decision = await policy.check(bash("npm test"));
		expect(decision).toEqual({ allow: false, reason: NO_TERMINAL_REASON });
		expect(NO_TERMINAL_REASON).toContain("--yes");
		expect(denied).toEqual(["Bash"]);
	});

	it("honours allow rules from settings without asking", async () => {
		const { ask, state } = answering();
		const policy = new PermissionPolicy({ mode: "ask", allow: ["Bash( npm  test )", "GitAdd"], ask });
		expect(await policy.check(bash("npm test"))).toEqual({ allow: true });
		expect(await policy.check({ tool: "GitAdd", input: {}, summary: "" })).toEqual({ allow: true });
		expect(state.calls).toBe(0);
	});

	it("denies everything not allowed when mode is deny", async () => {
		const policy = new PermissionPolicy({ mode: "deny", allow: ["Edit"] });
		expect(await policy.check({ tool: "Edit", input: {}, summary: "" })).toEqual({ allow: true });
		expect(await policy.check(bash("ls"))).toMatchObject({ allow: false });
	});
});

describe("terminalAsker", () => {
	const ask = (answers: string[]) => {
		const out: string[] = [];
		const asker = terminalAsker(
			async () => answers.shift() ?? "",
			(t) => out.push(t),
		);
		return { asker, out };
	};

	it("maps y, a and n to once, session and deny with a reason", async () => {
		const req = bash("npm test");
		expect(await ask(["y"]).asker(req, ["Bash(npm test)"])).toEqual({ kind: "once" });
		expect(await ask(["a"]).asker(req, ["Bash(npm test)"])).toEqual({ kind: "session" });
		expect(await ask(["n", "flaky on CI"]).asker(req, ["Bash(npm test)"])).toEqual({
			kind: "deny",
			reason: "flaky on CI",
		});
		expect(await ask([""]).asker(req, [])).toMatchObject({ kind: "deny" });
	});

	it("says which commands 'a' would allow, and falls back to once when it can't remember", async () => {
		const { asker, out } = ask(["a"]);
		expect(await asker(bash("echo $(date)"), [])).toEqual({ kind: "once" });
		expect(out.join("")).toContain("can't be remembered");
		const second = ask(["y"]);
		await second.asker(bash("npm test"), ["Bash(npm test)"]);
		expect(second.out.join("")).toContain("`npm test` commands");
	});
});

describe("permissions in the agent loop", () => {
	let dir: string;
	let client: GroundingClient;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "ledger-perm-"));
		client = new GroundingClient();
	});

	afterAll(async () => {
		client.close();
		await rm(dir, { recursive: true, force: true });
	});

	afterEach(() => {
		delete process.env.LEDGER_WORKSPACE;
	});

	async function run(steps: Step[], permissions: PermissionGate) {
		const seen: Message[][] = [];
		const events: AgentEvent[] = [];
		const evidence = new EvidenceLog();
		for await (const e of runAgent({
			providerName: "scripted",
			model: "scripted",
			system: "",
			messages: [{ role: "user", content: "go" }],
			groundingClient: client,
			evidence,
			permissions,
			provider: scriptedProvider(steps, seen),
		})) {
			events.push(e);
		}
		return { seen, events, evidence };
	}

	const denyAll = (reason: string): PermissionGate => ({ check: async () => ({ allow: false, reason }) });

	it("records a denied write as not executed and flags a claim that it happened", async () => {
		const file = join(dir, "notes.txt");
		const { seen, evidence, events } = await run(
			[{ calls: [{ name: "Write", input: { path: file, content: "hi" } }] }, { text: `I created ${file}.` }],
			denyAll("the user denied it (not now)"),
		);
		expect(existsSync(file)).toBe(false);
		expect(evidence.all()[0]).toMatchObject({
			tool: "Write",
			executed: false,
			is_error: true,
			args: { path: file },
		});

		const toolResult = seen[1]?.at(-1)?.content;
		expect(JSON.stringify(toolResult)).toContain("not now");

		const flag = events.find((e) => e.type === "grounding_flag");
		expect(flag).toMatchObject({
			claim: { kind: "file_created", verdict: "contradicted", rule: "not_executed" },
		});
	});

	it("catches 'I ran X' when the Bash call was denied", async () => {
		const { events, evidence } = await run(
			[
				{ calls: [{ name: "Bash", input: { command: "npm test" } }] },
				{ text: "I ran `npm test` successfully." },
			],
			denyAll(NO_TERMINAL_REASON),
		);
		expect(evidence.all()[0]).toMatchObject({ tool: "Bash", executed: false, args: { command: "npm test" } });
		expect(events.find((e) => e.type === "grounding_flag")).toMatchObject({
			claim: { kind: "command_success", verdict: "contradicted", rule: "not_executed", ref: "c1" },
		});
	});

	it("never asks for read-only tools", async () => {
		const gate: PermissionGate = {
			check: async (req) => {
				throw new Error(`asked for ${req.tool}`);
			},
		};
		const { events } = await run(
			[
				{
					calls: [
						{ name: "Ls", input: { path: "." } },
						{ name: "GitStatus", input: {} },
						{ name: "GitLog", input: { limit: 1 } },
					],
				},
				{ text: "Listed." },
			],
			gate,
		);
		const ends = events.filter((e) => e.type === "tool_end");
		expect(ends).toHaveLength(3);
		expect(ends.every((e) => e.type === "tool_end" && !e.result.includes("asked for"))).toBe(true);
	});

	it("still enforces LEDGER_WORKSPACE after the user allows a write", async () => {
		process.env.LEDGER_WORKSPACE = join(dir, "ws");
		const outside = join(dir, "escape.txt");
		const { evidence } = await run(
			[{ calls: [{ name: "Write", input: { path: outside, content: "x" } }] }, { text: "ok" }],
			{ check: async () => ({ allow: true }) },
		);
		expect(existsSync(outside)).toBe(false);
		expect(evidence.all()[0]).toMatchObject({ executed: true, is_error: true });
		expect(evidence.all()[0]?.raw_stderr).toContain("outside the workspace");
	});
});

import type { Swarm, SwarmEvent } from "../types";
import type { AppStep, Badge, Tone } from "./types";

export function clock(ms: number): string {
	const s = Math.round(ms / 1000);
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function shortTitle(prompt: string): string {
	const m = prompt.match(/^Work only inside the directory ([^/]+)\/\.\s*(.*)$/);
	return m ? m[2] : prompt;
}

export function verifiedCount(swarm: Swarm): number {
	return swarm.tasks.filter((t) => t.state === "merged" && t.verifyPassed).length;
}

export function swarmSteps(swarm: Swarm): AppStep[] {
	const names = swarm.tasks.map((t) => t.scenario);
	const merged: string[] = [];
	const log: { type: string; text: string }[] = [];
	const steps: AppStep[] = [];

	steps.push({
		phase: "Plan",
		title: "A goal becomes three subtasks",
		desc: `The planner splits the goal into subtasks and queues each one in ledgerd. Model ${swarm.model}, gate ${swarm.gate ? "on" : "off"}, at most ${swarm.maxAttempts} attempts a task.`,
		src: "planner",
		nodes: ["goal", "planner", ...names.map((_, i) => `w${i}`)],
		edges: ["goal-planner", ...names.map((_, i) => `planner-w${i}`)],
		payload: {
			swarm: swarm.id,
			goal: swarm.goal,
			model: swarm.model,
			gate: swarm.gate,
			max_attempts: swarm.maxAttempts,
			tasks: swarm.tasks.map((t) => ({ idx: t.idx, scenario: t.scenario, prompt: t.prompt })),
		},
		messages: swarm.tasks.map((t) => ({ label: t.scenario, text: t.prompt })),
		events: [{ type: "swarm.created", text: "swarm created" }, ...names.map((n) => ({ type: "task.queued", text: `${n}: queued` }))],
		badges: Object.fromEntries(names.map((_, i) => [`w${i}`, { text: "queued", tone: "info" as Tone }])),
	});
	log.push({ type: "swarm.created", text: "swarm created" });

	const rest = swarm.events.filter((e) => e.type !== "swarm.created" && !(e.type === "task.queued" && e.attempt === null));
	const at = (e: SwarmEvent) => (e.task === null ? "" : names[e.task]);
	for (const e of rest) {
		const i = e.task ?? 0;
		const w = `w${i}`;
		const d = e.data;
		const line = { type: e.type, text: `${at(e) ? `${at(e)}: ` : ""}${e.message}` };
		log.push(line);
		const base = { events: log.slice(-6), messages: [] as { label: string; text: string }[], badges: {} as Record<string, Badge> };
		const stamp = `+${clock(e.at)}`;
		switch (e.type) {
			case "task.claimed":
				steps.push({
					...base,
					phase: "Claim",
					title: `${names[i]} claims attempt ${e.attempt}`,
					desc: `The worker calls ClaimAttempt and gets a lease on the task, a branch and its prompt. ${stamp} into the run.`,
					src: "claim",
					nodes: [w, "ledgerd", "pg"],
					edges: [`${w}-ledgerd`, "ledgerd-pg"],
					payload: { task: names[i], attempt: e.attempt, branch: `ledger/fleet-${swarm.short}-${i + 1}` },
					badges: { [w]: { text: `attempt ${e.attempt} running`, tone: "info" } },
				});
				break;
			case "attempt.completed":
				steps.push({
					...base,
					phase: "Complete",
					title: `${names[i]} finishes attempt ${e.attempt}`,
					desc: `The worker calls CompleteAttempt with its exit code and its branch. ledgerd publishes the event on Redis. ${stamp} into the run.`,
					src: "complete",
					nodes: [w, "ledgerd", "redis"],
					edges: [`${w}-ledgerd`, "ledgerd-redis"],
					payload: { task: names[i], attempt: e.attempt, exit_code: d.exitCode, turns: d.turns, flagged_turns: d.flaggedTurns },
					messages: d.reply ? [{ label: "Worker's last words", text: String(d.reply) }] : [],
					badges: { [w]: { text: `attempt ${e.attempt} done`, tone: "info" } },
				});
				break;
			case "gate.pass":
			case "gate.retry":
			case "gate.fail":
			case "gate.block": {
				const decision = e.type.slice(5);
				const tone: Tone = decision === "pass" ? "ok" : decision === "retry" ? "warn" : "bad";
				const retry = decision === "retry";
				steps.push({
					...base,
					phase: "Gate",
					title: `${decision.toUpperCase()} for ${names[i]}`,
					desc: `${e.message}. The checker's verdicts for the attempt go through Decide.${retry ? " A retry goes back to ledgerd with feedback." : ""}`,
					src: "decide",
					nodes: ["ledgerd", "checker", "gate", ...(retry ? [w] : [])],
					edges: ["ledgerd-checker", "checker-gate", ...(retry ? ["gate-ledgerd"] : [])],
					payload: { task: names[i], decision, reason: e.message, attempt: d.attempt, max_attempts: d.maxAttempts, commit: d.commit || null, feedback: d.feedback || null },
					messages: d.feedback ? [{ label: "Feedback for the next attempt", text: String(d.feedback) }] : [{ label: "Reason", text: e.message }],
					badges: { gate: { text: `${decision.toUpperCase()} ${names[i]}`, tone }, [w]: { text: `${decision}`, tone } },
				});
				break;
			}
			case "task.queued":
				steps.push({
					...base,
					phase: "Retry",
					title: `${names[i]} is queued again`,
					desc: "The task goes back to the queue. The feedback is stored on it and goes in front of the next prompt.",
					src: "withFeedback",
					nodes: ["gate", "ledgerd", "pg", w],
					edges: ["gate-ledgerd", "ledgerd-pg"],
					payload: { task: names[i], next_attempt: e.attempt },
					badges: { [w]: { text: "queued again", tone: "warn" } },
				});
				break;
			case "task.merging":
				steps.push({
					...base,
					phase: "Merge",
					title: `${names[i]} enters the merge queue`,
					desc: "Merges happen one at a time in the integration worktree. A failed merge is aborted and the worktree reset.",
					src: "claimMerge",
					nodes: ["gate", "mq"],
					edges: ["gate-mq"],
					payload: { task: names[i], branch: `ledger/fleet-${swarm.short}-${i + 1}` },
					badges: { mq: { text: names[i], tone: "info" }, [w]: { text: "merging", tone: "info" } },
				});
				break;
			case "task.merged": {
				merged.push(String(d.commit));
				steps.push({
					...base,
					phase: "Merge",
					title: `${names[i]} is merged`,
					desc: `The commit joins the integration branch. ${stamp} into the run.`,
					src: "finishMerge",
					nodes: ["mq", "integ"],
					edges: ["mq-integ"],
					payload: { task: names[i], commit: d.commit, branch: d.branch, integration: ["base", ...merged] },
					badges: { integ: { text: `base + ${merged.length}`, tone: "ok" }, [w]: { text: `merged ${d.commit}`, tone: "ok" } },
				});
				break;
			}
			case "task.conflict":
				steps.push({
					...base,
					phase: "Merge",
					title: `${names[i]} conflicts`,
					desc: "The merge did not apply cleanly and was aborted.",
					src: "finishMerge",
					nodes: ["mq"],
					edges: [],
					payload: { task: names[i] },
					badges: { mq: { text: "conflict", tone: "bad" }, [w]: { text: "conflict", tone: "bad" } },
				});
				break;
			case "swarm.done": {
				const ok = verifiedCount(swarm);
				steps.push({
					...base,
					phase: "Done",
					title: "The swarm is done",
					desc: `After the swarm, each problem's own verify command runs on the integration branch. ${ok} of ${swarm.tasks.length} merged and verified. Recorded run time ${clock(swarm.seconds * 1000)}.`,
					src: "events",
					nodes: ["integ", "ledgerd", "redis"],
					edges: ["ledgerd-redis"],
					payload: {
						seconds: swarm.seconds,
						merged_and_verified: ok,
						tasks: swarm.tasks.map((t) => ({ scenario: t.scenario, state: t.state, attempts: t.attempts, verify_passed: t.verifyPassed })),
					},
					badges: { integ: { text: `${ok} of ${swarm.tasks.length} verified`, tone: ok === swarm.tasks.length ? ("ok" as Tone) : ("warn" as Tone) } },
				});
				break;
			}
			default:
				break;
		}
	}
	return steps;
}

export { shortTitle };

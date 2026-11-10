import type { Graph } from "./types";

const W = 170;
const H = 64;

export const checkerGraph: Graph = {
	nodes: [
		{ id: "msg", x: 0, y: 0, w: W, h: H, label: "Final message", sub: ["what the agent says"], cat: "input" },
		{ id: "evidence", x: 0, y: 170, w: W, h: H, label: "Evidence log", sub: ["Bash, Write, Edit calls"], cat: "data" },
		{ id: "split", x: 230, y: 0, w: W, h: H, label: "Claim splitter", sub: ["ExtractClaims"], cat: "logic" },
		{ id: "claim", x: 460, y: 0, w: W, h: H, label: "Claims", sub: ["kind and sentence"], cat: "data" },
		{ id: "attr", x: 690, y: 85, w: W, h: H, label: "Attribution", sub: ["tag, mention, family"], cat: "logic" },
		{ id: "rule", x: 920, y: 85, w: W, h: H, label: "Rule", sub: ["one per kind"], cat: "logic" },
		{ id: "verdict", x: 1150, y: 85, w: W, h: H, label: "Verdict", sub: ["verified, contradicted"], cat: "decision" },
		{ id: "gate", x: 1150, y: 255, w: W, h: H, label: "Gate", sub: ["PASS RETRY BLOCK FAIL"], cat: "decision" },
		{ id: "feedback", x: 920, y: 255, w: W, h: H, label: "Feedback", sub: ["flagged claims"], cat: "data" },
		{ id: "next", x: 690, y: 255, w: W, h: H, label: "Next attempt", sub: ["feedback in the prompt"], cat: "input" },
		{ id: "merge", x: 1150, y: 425, w: W, h: H, label: "Merge", sub: ["integration branch"], cat: "good" },
		{ id: "stop", x: 920, y: 425, w: W, h: H, label: "No merge", sub: ["blocked or failed"], cat: "bad" },
	],
	edges: [
		{ id: "msg-split", from: "msg", to: "split" },
		{ id: "split-claim", from: "split", to: "claim" },
		{ id: "claim-attr", from: "claim", to: "attr" },
		{ id: "evidence-attr", from: "evidence", to: "attr" },
		{ id: "attr-rule", from: "attr", to: "rule" },
		{ id: "rule-verdict", from: "rule", to: "verdict" },
		{ id: "verdict-gate", from: "verdict", to: "gate" },
		{ id: "gate-feedback", from: "gate", to: "feedback", label: "retry" },
		{ id: "feedback-next", from: "feedback", to: "next" },
		{ id: "gate-merge", from: "gate", to: "merge", label: "pass" },
		{ id: "gate-stop", from: "gate", to: "stop", label: "block or fail" },
	],
};

export function swarmGraph(workers: string[]): Graph {
	return {
		nodes: [
			{ id: "goal", x: 0, y: 190, w: 140, h: H, label: "Goal", sub: ["ledger swarm"], cat: "input" },
			{ id: "planner", x: 190, y: 190, w: 150, h: H, label: "Planner", sub: ["splits into subtasks"], cat: "logic" },
			...workers.map((label, i) => ({
				id: `w${i}`,
				x: 400,
				y: 40 + i * 150,
				w: 190,
				h: 70,
				label,
				sub: ["worktree, ledger --print"],
				cat: "logic" as const,
			})),
			{ id: "ledgerd", x: 660, y: 170, w: 230, h: 104, label: "ledgerd", sub: ["ClaimAttempt, Heartbeat", "RecordTurn, CompleteAttempt"], cat: "store" },
			{ id: "redis", x: 660, y: -10, w: 230, h: 56, label: "Redis", sub: ["events"], cat: "store" },
			{ id: "pg", x: 660, y: 370, w: 230, h: 56, label: "Postgres", sub: ["queue and verdicts"], cat: "store" },
			{ id: "checker", x: 950, y: 60, w: 160, h: H, label: "Checker", sub: ["Evaluate"], cat: "logic" },
			{ id: "gate", x: 950, y: 190, w: 160, h: H, label: "Gate", sub: ["Decide"], cat: "decision" },
			{ id: "mq", x: 950, y: 320, w: 160, h: H, label: "Merge queue", sub: ["one at a time"], cat: "decision" },
			{ id: "integ", x: 1170, y: 320, w: 170, h: 84, label: "Integration branch", sub: ["merged commits"], cat: "good" },
		],
		edges: [
			{ id: "goal-planner", from: "goal", to: "planner" },
			...workers.map((_, i) => ({ id: `planner-w${i}`, from: "planner", to: `w${i}` })),
			...workers.map((_, i) => ({ id: `w${i}-ledgerd`, from: `w${i}`, to: "ledgerd" })),
			{ id: "ledgerd-redis", from: "ledgerd", to: "redis" },
			{ id: "ledgerd-pg", from: "ledgerd", to: "pg" },
			{ id: "ledgerd-checker", from: "ledgerd", to: "checker" },
			{ id: "checker-gate", from: "checker", to: "gate" },
			{ id: "gate-ledgerd", from: "gate", to: "ledgerd", label: "retry" },
			{ id: "gate-mq", from: "gate", to: "mq" },
			{ id: "mq-integ", from: "mq", to: "integ" },
		],
	};
}

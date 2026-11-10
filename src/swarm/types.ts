export type SwarmState =
	| "SWARM_STATE_UNSPECIFIED"
	| "SWARM_STATE_RUNNING"
	| "SWARM_STATE_DONE"
	| "SWARM_STATE_CANCELLED";

export type TaskState =
	| "TASK_STATE_UNSPECIFIED"
	| "TASK_STATE_QUEUED"
	| "TASK_STATE_RUNNING"
	| "TASK_STATE_PASSED"
	| "TASK_STATE_MERGING"
	| "TASK_STATE_MERGED"
	| "TASK_STATE_CONFLICT"
	| "TASK_STATE_BLOCKED"
	| "TASK_STATE_FAILED"
	| "TASK_STATE_CANCELLED";

export type GateDecision =
	| "GATE_DECISION_UNSPECIFIED"
	| "GATE_DECISION_PASS"
	| "GATE_DECISION_RETRY"
	| "GATE_DECISION_BLOCK"
	| "GATE_DECISION_FAIL";

export interface SubtaskSpec {
	title: string;
	prompt: string;
}

export interface CreateSwarmRequest {
	idempotencyKey: string;
	goal: string;
	subtasks: SubtaskSpec[];
	repo: string;
	baseRef: string;
	model: string;
	gate: boolean;
	maxAttempts: number;
}

export interface Attempt {
	id?: string;
	number?: number;
	workerId?: string;
	runId?: string;
	decision?: GateDecision;
	feedback?: string;
	branch?: string;
	commit?: string;
	exitCode?: number;
	flaggedTurns?: number;
	turns?: number;
	startedAt?: string;
	finishedAt?: string;
}

export interface Task {
	id: string;
	swarmId?: string;
	index?: number;
	title?: string;
	prompt?: string;
	state?: TaskState;
	attempts?: Attempt[];
	detail?: string;
}

export interface Swarm {
	id: string;
	goal?: string;
	repo?: string;
	baseRef?: string;
	model?: string;
	gate?: boolean;
	maxAttempts?: number;
	state?: SwarmState;
	createdAt?: string;
	finishedAt?: string;
	taskCounts?: Record<string, number>;
}

export interface CreateSwarmResponse {
	swarm: Swarm;
	duplicate?: boolean;
}

export interface GetSwarmResponse {
	swarm: Swarm;
	tasks?: Task[];
}

export interface ListSwarmsResponse {
	swarms?: Swarm[];
	next?: string;
}

export interface CancelSwarmResponse {
	swarm?: Swarm;
}

export interface Assignment {
	swarmId: string;
	taskId: string;
	attemptId: string;
	attemptNumber?: number;
	runId: string;
	title?: string;
	prompt: string;
	feedback?: string;
	repo?: string;
	baseRef?: string;
	model?: string;
	leaseSeconds?: number;
	branch?: string;
}

export interface ClaimAttemptRequest {
	workerId: string;
	leaseSeconds: number;
	swarmId?: string;
}

export interface ClaimAttemptResponse {
	assignment?: Assignment;
}

export interface HeartbeatResponse {
	leaseHeld?: boolean;
	cancelled?: boolean;
}

export interface CompleteAttemptRequest {
	attemptId: string;
	workerId: string;
	exitCode: number;
	branch: string;
	commit: string;
	filesChanged: string[];
	summary: string;
	error: string;
}

export interface CompleteAttemptResponse {
	decision?: GateDecision;
	reason?: string;
	flaggedTurns?: number;
	turns?: number;
}

export interface MergeJob {
	swarmId: string;
	taskId: string;
	branch: string;
	commit?: string;
	title?: string;
	repo?: string;
}

export interface ClaimMergeRequest {
	swarmId: string;
	workerId: string;
	leaseSeconds: number;
}

export interface ClaimMergeResponse {
	job?: MergeJob;
	swarmFinished?: boolean;
}

export interface FinishMergeRequest {
	taskId: string;
	workerId: string;
	merged: boolean;
	detail: string;
}

export interface FinishMergeResponse {
	task?: Task;
}

export interface SwarmEvent {
	swarmId?: string;
	taskId?: string;
	attemptId?: string;
	type?: string;
	message?: string;
	dataJson?: string;
	at?: string;
}

export interface WireEvidence {
	ref: string;
	seq: number;
	tool: string;
	args: Record<string, unknown>;
	rawStdout: string;
	rawStderr: string;
	exitCode?: number;
	executed: boolean;
	isError: boolean;
	durationMs: string;
	diff?: string;
}

export interface RecordTurnRequest {
	runId: string;
	turn: number;
	turnText: string;
	evidence: WireEvidence[];
	freshRefs: string[];
	run: { source: string; model: string; task: string };
}

export interface RecordTurnResponse {
	duplicate?: boolean;
	judgeQueued?: boolean;
}

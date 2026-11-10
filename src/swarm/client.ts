import { setTimeout as sleep } from "node:timers/promises";
import type {
	CancelSwarmResponse,
	ClaimAttemptRequest,
	ClaimAttemptResponse,
	ClaimMergeRequest,
	ClaimMergeResponse,
	CompleteAttemptRequest,
	CompleteAttemptResponse,
	CreateSwarmRequest,
	CreateSwarmResponse,
	FinishMergeRequest,
	FinishMergeResponse,
	GetSwarmResponse,
	HeartbeatResponse,
	ListSwarmsResponse,
	RecordTurnRequest,
	RecordTurnResponse,
} from "./types.js";

const STATUS_CODES: Record<number, string> = {
	400: "invalid_argument",
	401: "unauthenticated",
	403: "permission_denied",
	404: "not_found",
	408: "deadline_exceeded",
	409: "aborted",
	412: "failed_precondition",
	429: "resource_exhausted",
	499: "canceled",
	500: "internal",
	501: "unimplemented",
	502: "unavailable",
	503: "unavailable",
	504: "unavailable",
};

export class ConnectError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ConnectError";
	}

	get retryable(): boolean {
		return this.status >= 500 || this.code === "unavailable";
	}
}

export interface ClientOptions {
	baseUrl: string;
	timeoutMs?: number;
	retries?: number;
	backoffMs?: number;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
}

const SWARM = "ledger.v1.SwarmService";
const VERIFY = "ledger.v1.VerifyService";

export function normalizeServerUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

export class LedgerClient {
	readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly retries: number;
	private readonly backoffMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly pause: (ms: number) => Promise<void>;
	private readonly random: () => number;

	constructor(options: ClientOptions) {
		this.baseUrl = normalizeServerUrl(options.baseUrl);
		this.timeoutMs = options.timeoutMs ?? 10_000;
		this.retries = options.retries ?? 4;
		this.backoffMs = options.backoffMs ?? 200;
		this.fetchImpl = options.fetch ?? fetch;
		this.pause = options.sleep ?? ((ms) => sleep(ms));
		this.random = options.random ?? Math.random;
	}

	private async once(url: string, body: unknown): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json", "connect-protocol-version": "1" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new ConnectError("unavailable", `${url}: ${reason}`, 0);
		}
		const text = await response.text().catch(() => "");
		if (response.ok) return text ? JSON.parse(text) : {};
		let code = STATUS_CODES[response.status] ?? "unknown";
		let message = text.slice(0, 200) || response.statusText;
		try {
			const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
			if (typeof parsed.code === "string") code = parsed.code;
			if (typeof parsed.message === "string") message = parsed.message;
		} catch {}
		throw new ConnectError(code, message, response.status);
	}

	async call<Res>(service: string, method: string, body: unknown): Promise<Res> {
		const url = `${this.baseUrl}/${service}/${method}`;
		for (let attempt = 0; ; attempt++) {
			try {
				return (await this.once(url, body)) as Res;
			} catch (err) {
				const retryable = err instanceof ConnectError && err.retryable;
				if (!retryable || attempt >= this.retries) throw err;
				const delay = this.backoffMs * 2 ** attempt * (0.5 + this.random() / 2);
				await this.pause(delay);
			}
		}
	}

	createSwarm(request: CreateSwarmRequest): Promise<CreateSwarmResponse> {
		return this.call(SWARM, "CreateSwarm", request);
	}

	getSwarm(swarmId: string): Promise<GetSwarmResponse> {
		return this.call(SWARM, "GetSwarm", { swarmId });
	}

	listSwarms(limit = 20, before = ""): Promise<ListSwarmsResponse> {
		return this.call(SWARM, "ListSwarms", { limit, before });
	}

	cancelSwarm(swarmId: string): Promise<CancelSwarmResponse> {
		return this.call(SWARM, "CancelSwarm", { swarmId });
	}

	claimAttempt(request: ClaimAttemptRequest): Promise<ClaimAttemptResponse> {
		return this.call(SWARM, "ClaimAttempt", request);
	}

	heartbeat(attemptId: string, workerId: string): Promise<HeartbeatResponse> {
		return this.call(SWARM, "Heartbeat", { attemptId, workerId });
	}

	completeAttempt(request: CompleteAttemptRequest): Promise<CompleteAttemptResponse> {
		return this.call(SWARM, "CompleteAttempt", request);
	}

	claimMerge(request: ClaimMergeRequest): Promise<ClaimMergeResponse> {
		return this.call(SWARM, "ClaimMerge", request);
	}

	finishMerge(request: FinishMergeRequest): Promise<FinishMergeResponse> {
		return this.call(SWARM, "FinishMerge", request);
	}

	recordTurn(request: RecordTurnRequest): Promise<RecordTurnResponse> {
		return this.call(VERIFY, "RecordTurn", request);
	}
}

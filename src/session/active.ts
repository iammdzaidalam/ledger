import type { Compaction } from "../agent/compaction.js";
import type { AgentEvent } from "../agent/types.js";
import { EvidenceLog } from "../grounding/evidence.js";
import type { Evidence } from "../grounding/types.js";
import type { Message } from "../types.js";
import { appendEntry, sessionPath } from "./store.js";
import type { ClaimRecord, NewSessionEntry, SessionData } from "./types.js";

export function restoreEvidence(entries: Evidence[]): EvidenceLog {
	const log = new EvidenceLog();
	for (const e of entries) {
		log.record(e.tool, {
			args: e.args,
			raw_stdout: e.raw_stdout,
			raw_stderr: e.raw_stderr,
			exit_code: e.exit_code,
			executed: e.executed,
			is_error: e.is_error,
			duration_ms: e.duration_ms,
			...(e.diff === undefined ? {} : { diff: e.diff }),
		});
	}
	log.takeFresh();
	return log;
}

export const CANCELLED_NOTE = "(The user cancelled this turn before it finished.)";

export class ActiveSession {
	history: Message[];
	evidence: EvidenceLog;
	claims: ClaimRecord[];
	private persisted: number;
	private savedEvidence: number;
	private metaWritten: boolean;

	private constructor(
		readonly id: string,
		readonly path: string,
		public providerName: string,
		public model: string,
		data?: SessionData,
	) {
		this.history = data ? [...data.messages] : [];
		this.evidence = restoreEvidence(data?.evidence ?? []);
		this.claims = data ? [...data.claims] : [];
		this.persisted = this.history.length;
		this.savedEvidence = this.evidence.all().length;
		this.metaWritten = data !== undefined && data.provider === providerName && data.model === model;
	}

	static create(id: string, providerName: string, model: string, cwd = process.cwd()): ActiveSession {
		return new ActiveSession(id, sessionPath(id, cwd), providerName, model);
	}

	static fromData(data: SessionData, providerName: string, model: string): ActiveSession {
		return new ActiveSession(data.id, data.path, providerName, model, data);
	}

	private async append(entry: NewSessionEntry): Promise<void> {
		if (!this.metaWritten) {
			this.metaWritten = true;
			await appendEntry(this.path, { type: "meta", provider: this.providerName, model: this.model });
		}
		await appendEntry(this.path, entry);
	}

	private async persistUpTo(messages: Message[]): Promise<void> {
		for (const message of messages.slice(this.persisted)) await this.append({ type: "message", message });
	}

	async addUserMessage(content: string): Promise<void> {
		const message: Message = { role: "user", content };
		this.history.push(message);
		await this.append({ type: "message", message });
		this.persisted = this.history.length;
	}

	async record(event: AgentEvent): Promise<void> {
		if (event.type === "evidence") await this.saveEvidence();
		if (event.type === "grounding_check" && event.claims.length > 0) {
			const record = { timestamp: new Date().toISOString(), claims: event.claims };
			this.claims.push(record);
			await this.append({ type: "claims", claims: event.claims });
		}
		if (event.type === "compaction") await this.applyCompaction(event.compaction);
		if (event.type === "agent_end") {
			await this.persistUpTo(event.messages);
			this.history = [...event.messages];
			this.persisted = this.history.length;
		}
	}

	private async saveEvidence(): Promise<void> {
		for (const entry of this.evidence.all().slice(this.savedEvidence))
			await this.append({ type: "evidence", entry });
		this.savedEvidence = this.evidence.all().length;
	}

	async cancelTurn(): Promise<void> {
		await this.saveEvidence();
		if (this.history.at(-1)?.role !== "user") return;
		const message: Message = { role: "assistant", content: [{ type: "text", text: CANCELLED_NOTE }] };
		this.history.push(message);
		await this.append({ type: "message", message });
		this.persisted = this.history.length;
	}

	async applyCompaction(compaction: Compaction): Promise<void> {
		await this.persistUpTo(compaction.before);
		await this.append({ type: "compaction", summary: compaction.summary, keep: compaction.keep });
		this.history = [...compaction.messages];
		this.persisted = this.history.length;
	}

	async clear(): Promise<void> {
		this.history = [];
		this.persisted = 0;
		await this.append({ type: "clear" });
	}

	switchModel(providerName: string, model: string): void {
		this.providerName = providerName;
		this.model = model;
		this.metaWritten = false;
	}
}

import type { RawExecution } from "../tools/types.js";
import type { Evidence } from "./types.js";

export class EvidenceLog {
	private entries: Evidence[] = [];
	private fresh: string[] = [];

	record(tool: string, exec: RawExecution): Evidence {
		const seq = this.entries.length + 1;
		const entry: Evidence = { ref: `c${seq}`, seq, tool, ...exec };
		this.entries.push(entry);
		this.fresh.push(entry.ref);
		return entry;
	}

	all(): Evidence[] {
		return this.entries;
	}

	takeFresh(): string[] {
		const refs = this.fresh;
		this.fresh = [];
		return refs;
	}
}

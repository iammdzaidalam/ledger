import { setTimeout as sleep } from "node:timers/promises";
import type { LedgerClient } from "./client.js";
import { addIntegration, mergeInto } from "./worktree.js";

export type MergeApi = Pick<LedgerClient, "claimMerge" | "finishMerge">;

export interface MergeConfig {
	client: MergeApi;
	repo: string;
	swarmId: string;
	baseRef: string;
	workerId: string;
	leaseSeconds: number;
	pollMs?: number;
	log?: (line: string) => void;
}

export async function runMergeQueue(config: MergeConfig, signal: AbortSignal): Promise<void> {
	const log = config.log ?? (() => undefined);
	const pollMs = config.pollMs ?? 1000;
	const integration = await addIntegration(config.repo, config.swarmId, config.baseRef);
	while (!signal.aborted) {
		let claim: Awaited<ReturnType<MergeApi["claimMerge"]>> | undefined;
		try {
			claim = await config.client.claimMerge({
				swarmId: config.swarmId,
				workerId: config.workerId,
				leaseSeconds: config.leaseSeconds,
			});
		} catch (err) {
			log(`merge claim failed: ${(err as Error).message}`);
		}
		if (claim?.swarmFinished) return;
		const job = claim?.job;
		if (!job?.taskId) {
			await sleep(pollMs, undefined, { signal }).catch(() => undefined);
			continue;
		}
		const title = job.title || job.taskId;
		const outcome = await mergeInto(integration.path, job.commit || job.branch, `Merge ${title}`);
		log(outcome.merged ? `${title}: merged` : `${title}: ${outcome.detail}`);
		await config.client.finishMerge({
			taskId: job.taskId,
			workerId: config.workerId,
			merged: outcome.merged,
			detail: outcome.merged ? "" : outcome.detail,
		});
	}
}

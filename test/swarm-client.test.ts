import { describe, expect, it } from "vitest";
import { ConnectError, LedgerClient } from "../src/swarm/client.js";

type Reply = Response | Error;

function stub(replies: Reply[]) {
	const calls: { url: string; init: RequestInit }[] = [];
	const delays: number[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const next = replies[Math.min(calls.length - 1, replies.length - 1)];
		if (next instanceof Error) throw next;
		return next?.clone();
	}) as unknown as typeof fetch;
	const client = new LedgerClient({
		baseUrl: "http://server.test/",
		fetch: fetchImpl,
		sleep: async (ms) => {
			delays.push(ms);
		},
		random: () => 1,
		retries: 3,
		backoffMs: 100,
	});
	return { client, calls, delays };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("LedgerClient", () => {
	it("posts protojson to the Connect path and reads the reply", async () => {
		const { client, calls } = stub([json({ swarm: { id: "s1" }, tasks: [] })]);
		const reply = await client.getSwarm("s1");
		expect(reply.swarm.id).toBe("s1");
		expect(calls[0]?.url).toBe("http://server.test/ledger.v1.SwarmService/GetSwarm");
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ swarmId: "s1" });
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
	});

	it("sends turns to the verify service", async () => {
		const { client, calls } = stub([json({})]);
		await client.recordTurn({
			runId: "r",
			turn: 1,
			turnText: "t",
			evidence: [],
			freshRefs: [],
			run: { source: "ledger-cli", model: "m", task: "x" },
		});
		expect(calls[0]?.url).toBe("http://server.test/ledger.v1.VerifyService/RecordTurn");
	});

	it("retries 5xx and unavailable with growing delays, then succeeds", async () => {
		const { client, calls, delays } = stub([
			json({ code: "unavailable", message: "down" }, 503),
			json({ code: "internal", message: "oops" }, 500),
			json({ leaseHeld: true }),
		]);
		expect(await client.heartbeat("a", "w")).toEqual({ leaseHeld: true });
		expect(calls).toHaveLength(3);
		expect(delays).toEqual([100, 200]);
	});

	it("retries network errors and timeouts", async () => {
		const { client, calls } = stub([new TypeError("fetch failed"), new Error("timed out"), json({})]);
		await client.cancelSwarm("s1");
		expect(calls).toHaveLength(3);
	});

	it("never retries a 4xx", async () => {
		for (const status of [400, 404, 409, 429]) {
			const { client, calls, delays } = stub([json({ code: "invalid_argument", message: "bad" }, status)]);
			await expect(client.getSwarm("x")).rejects.toMatchObject({ status });
			expect(calls).toHaveLength(1);
			expect(delays).toEqual([]);
		}
	});

	it("carries the Connect code and message on the error", async () => {
		const { client } = stub([json({ code: "not_found", message: "no such swarm" }, 404)]);
		const err = await client.getSwarm("x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConnectError);
		expect(err).toMatchObject({ code: "not_found", message: "no such swarm", status: 404 });
	});

	it("derives a code from the status when the body is not JSON", async () => {
		const { client } = stub([new Response("bad gateway", { status: 502 })]);
		const err = await client.getSwarm("x").catch((e: unknown) => e);
		expect(err).toMatchObject({ code: "unavailable", status: 502 });
	});

	it("gives up after the configured number of retries", async () => {
		const { client, calls } = stub([json({ code: "unavailable", message: "down" }, 503)]);
		await expect(client.getSwarm("x")).rejects.toMatchObject({ code: "unavailable" });
		expect(calls).toHaveLength(4);
	});

	it("times out a call that never answers", async () => {
		const hang = (async (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			})) as unknown as typeof fetch;
		const client = new LedgerClient({ baseUrl: "http://x", fetch: hang, timeoutMs: 30, retries: 0 });
		await expect(client.getSwarm("x")).rejects.toMatchObject({ code: "unavailable" });
	});
});

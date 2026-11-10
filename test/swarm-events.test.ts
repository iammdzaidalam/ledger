import { afterEach, describe, expect, it } from "vitest";
import { parseSseData, readEvents } from "../src/swarm/events.js";
import type { SwarmEvent } from "../src/swarm/types.js";
import { type FakeServer, startFakeServer } from "./fleet-support.js";

let server: FakeServer | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("parseSseData", () => {
	it("reads the server's snake_case event", () => {
		const block =
			'data: {"swarm_id":"s1","task_id":"t1","type":"gate.pass","message":"ok","at":"2026-11-10T00:00:00Z"}';
		expect(parseSseData(block)).toMatchObject({
			swarmId: "s1",
			taskId: "t1",
			type: "gate.pass",
			message: "ok",
		});
	});

	it("ignores comments and bad payloads", () => {
		expect(parseSseData(": keepalive")).toBeUndefined();
		expect(parseSseData("data: not json")).toBeUndefined();
		expect(parseSseData("data: 12")).toBeUndefined();
	});
});

describe("readEvents", () => {
	it("streams events from the server until aborted", async () => {
		server = await startFakeServer();
		const client = await fetch(`${server.url}/ledger.v1.SwarmService/CreateSwarm`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				idempotencyKey: "k",
				goal: "g",
				subtasks: [{ title: "t", prompt: "p" }],
				baseRef: "x",
			}),
		});
		expect(client.ok).toBe(true);
		await fetch(`${server.url}/ledger.v1.SwarmService/ClaimAttempt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workerId: "w", leaseSeconds: 5 }),
		});
		const controller = new AbortController();
		const got: SwarmEvent[] = [];
		for await (const event of readEvents(server.url, "s1", controller.signal)) {
			got.push(event);
			controller.abort();
		}
		expect(got[0]).toMatchObject({ swarmId: "s1", type: "attempt.started" });
	});

	it("stops promptly when aborted before connecting", async () => {
		const controller = new AbortController();
		controller.abort();
		const got: SwarmEvent[] = [];
		for await (const event of readEvents("http://127.0.0.1:1", "s1", controller.signal)) got.push(event);
		expect(got).toEqual([]);
	});
});

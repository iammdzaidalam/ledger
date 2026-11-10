import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LABEL_GUIDE, renderTurn } from "./lib/render.js";
import { STRATA, type Stratum, seeded, shuffle, stratify } from "./lib/strata.js";
import { arg, loadSessions } from "./lib/trace.js";

const traces = resolve(arg("traces", "eval/traces/openhands") as string);
const dir = resolve(arg("out", "eval/packets/openhands") as string);
const take: Record<Stratum, number> = {
	flagged: Number(arg("flagged", "100000")),
	verified: Number(arg("verified", "600")),
	none: Number(arg("none", "1000")),
};
const second = Number(arg("second", "300"));
const maxBytes = Number(arg("packet-bytes", "90000"));

const turns = await stratify(await loadSessions(traces));
const next = seeded(Number(arg("seed", "23")));
const picked = STRATA.flatMap((h) =>
	shuffle(
		turns.filter((t) => t.stratum === h),
		next,
	).slice(0, take[h]),
);
const order = shuffle(picked, next);

async function writePackets(items: typeof order, sub: string) {
	await mkdir(join(dir, sub), { recursive: true });
	let packet: string[] = [];
	let size = 0;
	let n = 0;
	const flush = async () => {
		if (!packet.length) return;
		n++;
		await writeFile(
			join(dir, sub, `packet-${String(n).padStart(3, "0")}.txt`),
			`${LABEL_GUIDE}\n\n${packet.join("\n\n")}\n`,
		);
		packet = [];
		size = 0;
	};
	for (const t of items) {
		const body = `=== ITEM session=${t.session.meta.session} turn=${t.view.turn}\n${renderTurn(t.session, t.view)}`;
		if (size + body.length > maxBytes) await flush();
		packet.push(body);
		size += body.length;
	}
	await flush();
	return n;
}

await mkdir(dir, { recursive: true });
await writeFile(join(dir, "keys.txt"), `${order.map((t) => t.key).join("\n")}\n`);
const first = await writePackets(order, "a");
const again = await writePackets(shuffle(order, next).slice(0, second), "b");
await writeFile(
	join(dir, "sample.json"),
	`${JSON.stringify({ traces, totals: Object.fromEntries(STRATA.map((h) => [h, turns.filter((t) => t.stratum === h).length])), picked: Object.fromEntries(STRATA.map((h) => [h, picked.filter((t) => t.stratum === h).length])), second }, null, 2)}\n`,
);
console.log(
	`${turns.length} turns; sampled ${order.length} into ${first} packets, ${Math.min(second, order.length)} again into ${again} packets -> ${dir}`,
);

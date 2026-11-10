import { useMemo } from "react";
import swarmsJson from "../data/swarms.json";
import type { Swarm } from "../types";
import { swarmGraph } from "./graphs";
import type { AppName, Route } from "./route";
import { clock, swarmSteps, verifiedCount } from "./swarmSteps";
import { Workbench } from "./Workbench";

const swarms = swarmsJson as Swarm[];

export interface RunGroup {
	key: string;
	on: Swarm;
	off: Swarm;
}

export const groups: RunGroup[] = [];
for (const s of swarms) {
	const key = `${s.group}#${s.seed}`;
	let g = groups.find((x) => x.key === key);
	if (!g) {
		g = { key, on: s, off: s };
		groups.push(g);
	}
	if (s.gate) g.on = s;
	else g.off = s;
}

export function SwarmApp({ route, setRoute, onApp }: { route: Route; setRoute: (r: Route) => void; onApp: (a: AppName) => void }) {
	const index = Math.max(0, Math.min(groups.length - 1, Number.parseInt(route.key, 10) - 1));
	const swarm = route.gate ? groups[index].on : groups[index].off;
	const steps = useMemo(() => swarmSteps(swarm), [swarm]);
	const graph = useMemo(() => swarmGraph(swarm.tasks.map((t) => t.scenario)), [swarm]);
	const ok = verifiedCount(swarm);

	const controls = (
		<>
			<div className="wb__field">
				<span>Recorded run</span>
				<div className="wb__seg" role="group" aria-label="Recorded run">
					{groups.map((g, i) => (
						<button key={g.key} type="button" aria-pressed={index === i} onClick={() => setRoute({ ...route, key: String(i + 1), step: 0 })}>
							{i + 1}
						</button>
					))}
				</div>
			</div>
			<div className="wb__field">
				<span>Gate</span>
				<div className="wb__seg" role="group" aria-label="Gate mode">
					<button type="button" aria-pressed={route.gate} onClick={() => setRoute({ ...route, gate: true, step: 0 })}>
						On
					</button>
					<button type="button" aria-pressed={!route.gate} onClick={() => setRoute({ ...route, gate: false, step: 0 })}>
						Off
					</button>
				</div>
			</div>
			<p className="wb__readout">
				Merged and verified: <b>{ok} of {swarm.tasks.length}</b>
			</p>
		</>
	);

	return (
		<Workbench
			app="swarm"
			onApp={onApp}
			path="goal, planner, worktrees, ledgerd, checker, gate, merge queue, integration branch"
			controls={controls}
			status={
				<span>
					Replays recorded run <b className="mono">{swarm.short}</b>, {swarm.model}, {clock(swarm.seconds * 1000)} long
				</span>
			}
			graph={graph}
			steps={steps}
			step={route.step}
			onStep={(n) => setRoute({ ...route, step: n })}
			graphLabel="The Ledger fleet architecture, replaying one recorded swarm"
		/>
	);
}

import { useCallback, useEffect, useState } from "react";
import type { Initial } from "../lib/sandbox";
import { CheckerApp } from "./CheckerApp";
import { DEFAULT_ROUTE, type AppName, formatRoute, parseRoute, type Route } from "./route";
import { groups, SwarmApp } from "./SwarmApp";

export function PlaygroundApp({ initial }: { initial: Initial }) {
	const [route, setRouteState] = useState<Route>(() => (typeof window === "undefined" ? DEFAULT_ROUTE : parseRoute(window.location.hash, groups.length)));

	useEffect(() => {
		const on = () => setRouteState(parseRoute(window.location.hash, groups.length));
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);

	useEffect(() => {
		const next = formatRoute(route);
		if (window.location.hash !== next) window.history.replaceState(null, "", next);
	}, [route]);

	const setRoute = useCallback((r: Route) => setRouteState(r), []);
	const onApp = useCallback(
		(app: AppName) => setRouteState((r) => (r.app === app ? r : app === "swarm" ? { app, key: "1", gate: true, step: 0 } : { ...DEFAULT_ROUTE, app })),
		[],
	);

	return route.app === "swarm" ? <SwarmApp route={route} setRoute={setRoute} onApp={onApp} /> : <CheckerApp route={route} setRoute={setRoute} onApp={onApp} initial={initial} />;
}

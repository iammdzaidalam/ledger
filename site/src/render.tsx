import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { computeInitial, type Initial } from "./lib/sandbox";
import { runCheck } from "./lib/checker";
import { HeroDemo } from "./page/HeroDemo";
import { Page } from "./page/Page";
import { ReplayApp } from "./page/ReplayApp";

export function render(): { pages: Record<string, string>; initial: Initial } {
	const initial = computeInitial(runCheck);
	const home = renderToStaticMarkup(
		<Page
			html={{
				initial,
				hero: renderToString(<HeroDemo initial={initial} />, { identifierPrefix: "hd" }),
				replay: renderToString(<ReplayApp />),
			}}
		/>,
	);
	const playground = '<noscript><p style="padding:24px;font-family:sans-serif;color:#ece8df">The Ledger playground needs JavaScript. It runs the Go checker in your browser as WebAssembly.</p></noscript>';
	return { pages: { "index.html": home, "playground.html": playground }, initial };
}

import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { Page } from "./page/Page";
import { ReplayApp } from "./page/ReplayApp";

export function render(): string {
	const replayHtml = renderToString(<ReplayApp />);
	return renderToStaticMarkup(<Page replayHtml={replayHtml} />);
}

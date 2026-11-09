import { Box } from "ink";
import { Lines } from "./lines.js";
import type { Line } from "./text.js";

export interface Viewport {
	lines: Line[];
	first: number;
	above: number;
	below: number;
}

export function viewport(all: readonly Line[], height: number, top: number | null): Viewport {
	const max = Math.max(0, all.length - height);
	const start = top === null ? max : Math.max(0, Math.min(top, max));
	return {
		lines: all.slice(start, start + height),
		first: start,
		above: start,
		below: Math.max(0, all.length - (start + height)),
	};
}

export function Transcript({ view, width, height }: { view: Viewport; width: number; height: number }) {
	return (
		<Box flexDirection="column" width={width} height={height} paddingLeft={1} overflow="hidden">
			<Lines lines={view.lines} first={view.first} />
		</Box>
	);
}

import { Box } from "ink";
import { panelLines } from "./layout.js";
import { Lines } from "./lines.js";
import type { TuiState } from "./state.js";

export interface PanelProps {
	state: Pick<TuiState, "evidence" | "claims">;
	width: number;
	height: number;
}

export function Panel({ state, width, height }: PanelProps) {
	const inner = Math.max(10, width - 3);
	const lines = panelLines(state, inner, Math.max(1, height));
	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			borderStyle="single"
			borderTop={false}
			borderBottom={false}
			borderRight={false}
			borderDimColor
			paddingLeft={1}
			overflow="hidden"
		>
			<Lines lines={lines} />
		</Box>
	);
}

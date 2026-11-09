import { Box } from "ink";
import { type StatusInfo, statusLine } from "./layout.js";
import { LineView } from "./lines.js";

export function StatusBar({ info, width }: { info: StatusInfo; width: number }) {
	return (
		<Box width={width} height={1}>
			<LineView line={statusLine(info, width)} />
		</Box>
	);
}

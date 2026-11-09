import { Text } from "ink";
import { createContext, type ReactElement, useContext } from "react";
import type { Line, Segment, Tone } from "./text.js";

export const ColorContext = createContext(true);

const TONES: Record<Tone, string> = { accent: "blue", bad: "red" };

function SegmentView({ segment, color }: { segment: Segment; color: boolean }) {
	const s = segment.style ?? {};
	return (
		<Text
			color={color && s.tone ? TONES[s.tone] : undefined}
			bold={s.bold}
			italic={s.italic}
			underline={s.underline}
			dimColor={s.dim}
			inverse={s.inverse}
		>
			{segment.text}
		</Text>
	);
}

export function LineView({ line }: { line: Line }) {
	const color = useContext(ColorContext);
	if (line.length === 0) return <Text> </Text>;
	let offset = 0;
	const keyed = line.map((segment) => {
		const key = offset;
		offset += segment.text.length;
		return { key, segment };
	});
	return (
		<Text wrap="truncate-end">
			{keyed.map(({ key, segment }) => (
				<SegmentView key={key} segment={segment} color={color} />
			))}
		</Text>
	);
}

export function Lines({ lines, first = 0 }: { lines: readonly Line[]; first?: number }) {
	const items: ReactElement[] = [];
	let key = first;
	for (const line of lines) items.push(<LineView key={key++} line={line} />);
	return <>{items}</>;
}

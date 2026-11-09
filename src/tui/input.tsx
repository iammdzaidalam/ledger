import { Box } from "ink";
import { type Editor, editorLines } from "./editor.js";
import { Lines } from "./lines.js";
import { type Line, type Style, seg } from "./text.js";

export const MAX_INPUT_LINES = 8;

const PROMPT: Style = { tone: "accent", bold: true };

export function inputLines(editor: Editor, width: number, active: boolean, placeholder: string): Line[] {
	const prompt = seg("› ", PROMPT);
	if (!editor.text) {
		const cursor = active ? [seg(" ", { inverse: true })] : [];
		return [[prompt, ...cursor, seg(placeholder, { dim: true })]];
	}
	const { lines, cursorLine } = editorLines(editor, Math.max(4, width - 2), active);
	const start = Math.max(0, Math.min(cursorLine - (MAX_INPUT_LINES - 1), lines.length - MAX_INPUT_LINES));
	return lines
		.slice(start, start + MAX_INPUT_LINES)
		.map((line, i) => [start + i === 0 ? prompt : seg("  "), ...line]);
}

export function ruleLine(width: number): Line {
	return [seg("─".repeat(Math.max(0, width)), { dim: true })];
}

export interface InputBoxProps {
	lines: Line[];
	hints: Line[];
	width: number;
}

export function InputBox({ lines, hints, width }: InputBoxProps) {
	return (
		<Box flexDirection="column" width={width}>
			<Box paddingLeft={1} flexDirection="column">
				<Lines lines={hints} />
			</Box>
			<Lines lines={[ruleLine(width)]} />
			<Box paddingLeft={1} flexDirection="column">
				<Lines lines={lines} />
			</Box>
		</Box>
	);
}

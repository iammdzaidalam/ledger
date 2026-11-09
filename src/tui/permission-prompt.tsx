import { Box } from "ink";
import { type Editor, editorLines } from "./editor.js";
import { ruleLine } from "./input.js";
import { Lines } from "./lines.js";
import { type PendingPermission, scopeText } from "./permission.js";
import { clip, type Line, type Style, sanitize, seg, wrap } from "./text.js";

const KEY: Style = { tone: "accent", bold: true };

export function permissionLines(pending: PendingPermission, reason: Editor | null, width: number): Line[] {
	const inner = Math.max(10, width);
	const lines: Line[] = wrap(
		[
			seg("Allow "),
			seg(pending.request.tool, { bold: true }),
			seg(": "),
			seg(clip(sanitize(pending.request.summary).replace(/\n+/g, " ⏎ "), inner * 4), { bold: true }),
		],
		inner,
		{ indent: 2 },
	);
	if (reason) {
		lines.push([seg("Why not? This goes to the model. Enter sends, Esc skips.", { dim: true })]);
		const edited = editorLines(reason, inner - 2, true).lines;
		edited.forEach((line, i) => {
			lines.push([seg(i === 0 ? "› " : "  ", KEY), ...line]);
		});
		return lines;
	}
	const option = (key: string, text: string) =>
		wrap([seg(`  ${key}  `, KEY), seg(text)], inner, { indent: 5 });
	lines.push(...option("y", "yes, this once"));
	if (pending.rules.length > 0) {
		lines.push(...option("a", `yes, and allow ${scopeText(pending.rules)} for the rest of this session`));
	} else {
		lines.push(
			...wrap(
				[seg("     this command can't be remembered: it uses substitution or redirection", { dim: true })],
				inner,
				{
					indent: 5,
				},
			),
		);
	}
	lines.push(...option("n", "no, and tell the model why"));
	return lines;
}

export function PermissionPrompt({ lines, width }: { lines: Line[]; width: number }) {
	return (
		<Box flexDirection="column" width={width}>
			<Lines lines={[ruleLine(width)]} />
			<Box paddingLeft={1} flexDirection="column">
				<Lines lines={lines} />
			</Box>
		</Box>
	);
}

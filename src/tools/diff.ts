import { structuredPatch } from "diff";

const MAX_DIFF_CHARS = 4000;

export function unifiedDiff(path: string, before: string, after: string): string {
	if (before === after) return "";
	const patch = structuredPatch(path, path, before, after, "", "", { context: 1 });
	const text = patch.hunks
		.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n"))
		.join("\n");
	return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : text;
}

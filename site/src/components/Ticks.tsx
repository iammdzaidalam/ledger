import type { ReactNode } from "react";

export function withCode(text: string, keyPrefix = "t"): ReactNode[] {
	return text.split(/(`[^`\n]+`)/g).map((part, i) => {
		const key = `${keyPrefix}-${i}`;
		if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
			return (
				<code key={key} className="tick-code">
					{part}
				</code>
			);
		}
		return <span key={key}>{part}</span>;
	});
}

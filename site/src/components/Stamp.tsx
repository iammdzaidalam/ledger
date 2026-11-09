import type { Verdict } from "../types";

interface StampProps {
	verdict: Verdict;
	detail?: string;
	size?: "sm" | "md" | "lg";
	animate?: boolean;
}

export function Stamp({ verdict, detail, size = "md", animate = false }: StampProps) {
	return (
		<span className={`stamp stamp--${verdict} stamp--${size}${animate ? " stamp--press" : ""}`}>
			<span className="stamp__word">{verdict}</span>
			{detail ? <span className="stamp__detail">{detail}</span> : null}
		</span>
	);
}

export function FlagLine({ text }: { text: string }) {
	const m = text.match(/^\[([^\]]+)\](.*)$/s);
	if (!m) return <>{text}</>;
	return (
		<>
			[<b className="flag-word">{m[1]}</b>]{m[2]}
		</>
	);
}

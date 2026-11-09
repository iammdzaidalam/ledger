export function slug(s) {
	return s.trim().toLowerCase().replace(/\s+/g, "-");
}

export function titleCase(s) {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

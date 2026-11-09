import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export function workspaceRoot(): string | undefined {
	const root = process.env.LEDGER_WORKSPACE;
	return root ? resolve(root) : undefined;
}

export function outsideWorkspace(path: string): boolean {
	const root = workspaceRoot();
	if (!root) return false;
	const rel = relative(root, resolve(path));
	return rel.startsWith("..") || isAbsolute(rel);
}

export function shellCommand(command: string): { file: string; args: string[] } {
	if (process.platform === "win32") return { file: "cmd.exe", args: ["/c", command] };
	const root = workspaceRoot();
	if (!root || process.platform !== "darwin") return { file: "/bin/sh", args: ["-c", command] };

	const writable = [
		root,
		"/private/var/folders",
		"/private/tmp",
		"/dev",
		join(homedir(), "Library", "Caches"),
		join(homedir(), ".npm"),
		join(homedir(), "go"),
	];
	const profile = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* ${writable.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ")})`,
	].join("\n");
	return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command] };
}

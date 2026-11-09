import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const all = process.argv.includes("--all");
const targets = all
	? [
			["darwin", "arm64"],
			["darwin", "x64"],
			["linux", "arm64"],
			["linux", "x64"],
			["win32", "x64"],
		]
	: [[process.platform, process.arch]];

const goos = { darwin: "darwin", linux: "linux", win32: "windows" };
const goarch = { arm64: "arm64", x64: "amd64" };

for (const [platform, arch] of targets) {
	const ext = platform === "win32" ? ".exe" : "";
	const out = all
		? join(root, "bin", `grounding-checker-${platform}-${arch}${ext}`)
		: join(root, "bin", `grounding-checker${ext}`);
	execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."], {
		cwd: join(root, "checker"),
		stdio: "inherit",
		env: { ...process.env, GOOS: goos[platform], GOARCH: goarch[arch], CGO_ENABLED: "0" },
	});
	console.log(`built ${out}`);
}

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const checker = resolve(site, "..", "checker");
const out = join(site, "public");

mkdirSync(out, { recursive: true });
const target = join(out, "ledger.wasm");
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", target, "./cmd/ledger-wasm"], {
	cwd: checker,
	env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
	stdio: "inherit",
});
const root = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
const exec = [join(root, "lib", "wasm", "wasm_exec.js"), join(root, "misc", "wasm", "wasm_exec.js")].find((p) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
});
if (!exec) throw new Error("wasm_exec.js not found in the Go toolchain");
copyFileSync(exec, join(out, "wasm_exec.js"));
const raw = statSync(target).size;
const gz = gzipSync(readFileSync(target), { level: 9 }).length;
process.stdout.write(`ledger.wasm ${(raw / 1048576).toFixed(2)} MB, ${(gz / 1048576).toFixed(2)} MB gzipped\n`);

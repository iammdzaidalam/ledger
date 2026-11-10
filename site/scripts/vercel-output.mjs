import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(site, ".vercel", "output");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "static"), { recursive: true });
cpSync(join(site, "dist"), join(out, "static"), { recursive: true });

const config = {
	version: 3,
	routes: [
		{ src: "/assets/(.*)", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
		{ src: "/ledger.wasm", headers: { "content-type": "application/wasm", "cache-control": "public, max-age=3600" }, continue: true },
		{ handle: "filesystem" },
	],
};
writeFileSync(join(out, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write("wrote .vercel/output\n");

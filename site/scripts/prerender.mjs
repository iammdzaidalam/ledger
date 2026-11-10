import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appHead, head, scripts } from "./kit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const dist = join(site, "dist");
const ssr = join(site, ".ssr");

createRequire(import.meta.url)(join(site, "public", "wasm_exec.js"));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(readFileSync(join(site, "public", "ledger.wasm")), go.importObject);
void go.run(instance);
for (let i = 0; i < 200 && !globalThis.ledgerCheck; i++) await new Promise((r) => setTimeout(r, 10));
if (!globalThis.ledgerCheck) throw new Error("the checker did not start in node");

const { render } = await import(pathToFileURL(join(ssr, "render.js")).href);
const { pages, initial } = render();
for (const preset of JSON.parse(readFileSync(join(site, "src", "data", "sandbox.json"), "utf8"))) {
	if (preset.recorded.length === 0) continue;
	const got = initial[preset.id].claims.map((c) => `${c.kind}:${c.verdict}`).join(",");
	const want = preset.recorded.map((c) => `${c.kind}:${c.verdict}`).join(",");
	if (got !== want) throw new Error(`the checker no longer reproduces the recorded verdicts of ${preset.id}: ${got} against ${want}`);
}
const payload = JSON.stringify(initial).replace(/</g, "\\u003c");
const required = {
	"index.html": ["hero-island", "replay-island"],
	"playground.html": [],
};
for (const [name, page] of Object.entries(pages)) {
	const file = join(dist, name);
	let html = readFileSync(file, "utf8");
	const built = [...html.matchAll(/<script type="module" crossorigin src="[^"]+"><\/script>/g)].map((m) => m[0]);
	const preloads = [...html.matchAll(/<link rel="modulepreload" crossorigin href="[^"]+">/g)].map((m) => m[0]);
	const css = [...html.matchAll(/<link rel="stylesheet" crossorigin href="[^"]+">/g)].map((m) => m[0]);
	if (built.length === 0 || css.length === 0) throw new Error(`vite output not found in dist/${name}`);
	for (const tag of [...built, ...preloads, ...css]) html = html.replace(tag, "");
	const links = `${css.map((c) => c.replace(" crossorigin", "")).join("\n")}\n${preloads.join("\n")}`;
	html = html.replace("<!--kit-head-->", `${head}\n${links}`).replace("<!--app-head-->", `${appHead}\n${links}`);
	html = html.replace('<div id="page"><!--page--></div>', `${page}\n<script type="application/json" id="ledger-initial">${payload}</script>`).replace('<div id="app" class="wrap"><!--page--></div>', `<div id="app" class="wrap"></div>\n${page}\n<script type="application/json" id="ledger-initial">${payload}</script>`);
	html = html.includes("<!--kit-scripts-->") ? html.replace("<!--kit-scripts-->", `${built.join("\n")}\n${scripts}`) : html.replace("</body>", `${built.join("\n")}\n</body>`);
	for (const id of [...required[name], "ledger-initial"]) {
		if (!html.includes(`id="${id}"`)) throw new Error(`${name} did not render ${id}`);
	}
	writeFileSync(file, html);
	process.stdout.write(`prerendered dist/${name} (${html.length} bytes)\n`);
}
rmSync(ssr, { recursive: true, force: true });
process.exit(0);

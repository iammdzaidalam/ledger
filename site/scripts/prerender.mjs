import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const dist = join(site, "dist");
const ssr = join(site, ".ssr");

const head = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400..700&family=Funnel+Sans:wght@400..600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/system.css">
<link rel="stylesheet" href="assets/ui/cards.css">
<link rel="stylesheet" href="assets/motion/motion.css">
<link rel="stylesheet" href="assets/backgrounds/backgrounds.css">
<link rel="stylesheet" href="assets/layout/layout.css">
<link rel="stylesheet" href="assets/icons/icon.css">
<style>
:root {
  --p-bg: #f4f1ea; --p-surface: #b9d3cd; --p-ink: #141a19; --p-muted: #4a4e4b;
  --p-accent: #f24900; --p-accent-ink: #111111; --p-action: #f24900; --p-action-ink: #111111;
  --p-inv-bg: #141a19; --p-inv-surface: #212625; --p-inv-ink: #f4f1ea; --p-inv-muted: #969793;
  --p-inv-accent: #f24900; --p-inv-accent-ink: #111111; --p-inv-action: #f24900; --p-inv-action-ink: #111111;
  --font-display: "Funnel Display", system-ui, sans-serif;
  --font-text: "Funnel Sans", system-ui, sans-serif;
  --font-mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --display-weight: 400;
  --display-tracking: -0.03em;
  --display-tracking-xl: -0.04em;
  --ly-scale: 0.98;
}
</style>
<link rel="stylesheet" href="assets/ui/base.css">
<script>document.documentElement.classList.add('m-enter');setTimeout(()=>document.documentElement.classList.add('m-enter-done'),700)</script>
<script src="assets/backgrounds/backgrounds.js"></script>
<script>document.documentElement.classList.add('mo-js');setTimeout(()=>document.documentElement.classList.add('mo-safe'),2500)</script>
<link rel="modulepreload" href="assets/moments/moments.js">
<link rel="modulepreload" href="assets/moments/lib.js">
<link rel="modulepreload" href="assets/moments/liquid-type/moment.js">`;

const scripts = `<script type="module" src="assets/system.js"></script>
<script type="module" src="assets/motion/motion.js"></script>
<script type="module" src="assets/layout/layout.js"></script>`;

const { render } = await import(pathToFileURL(join(ssr, "render.js")).href);
const file = join(dist, "index.html");
let html = readFileSync(file, "utf8");
const page = render();
const built = html.match(/<script type="module" crossorigin src="[^"]+"><\/script>/);
const css = html.match(/<link rel="stylesheet" crossorigin href="[^"]+">/);
if (!built || !css) throw new Error("vite output not found in dist/index.html");
html = html.replace(built[0], "").replace(css[0], "");
html = html.replace("<!--kit-head-->", `${head}\n${css[0]}`);
html = html.replace('<div id="page"><!--page--></div>', page);
html = html.replace("<!--kit-scripts-->", `${built[0]}\n${scripts}`);
if (!html.includes('id="replay-island"')) throw new Error("page did not render");
writeFileSync(file, html);
rmSync(ssr, { recursive: true, force: true });
process.stdout.write(`prerendered dist/index.html (${html.length} bytes)\n`);

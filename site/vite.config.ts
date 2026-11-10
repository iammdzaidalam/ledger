import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { appHead, head, scripts } from "./scripts/kit.mjs";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		{
			name: "kit-assets",
			apply: "serve",
			transformIndexHtml: (html) => html.replace("<!--kit-head-->", head).replace("<!--kit-scripts-->", scripts).replace("<!--app-head-->", appHead),
		},
	],
	build: {
		outDir: "dist",
		assetsInlineLimit: 0,
		rollupOptions: {
			input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), playground: fileURLToPath(new URL("./playground.html", import.meta.url)) },
		},
	},
});

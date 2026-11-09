import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const outDir = join(site, "public", "art");
const dataFile = join(site, "src", "data", "art.json");
const rawDir = process.argv[2];

if (!rawDir) {
	process.stderr.write("usage: node scripts/prepare-art.mjs <dir with the source jpgs> [--only=syndics,moneylender] [--composite] [--faces]\n");
	process.exit(1);
}

const SOURCES = {
	pacioli: {
		artist: "Attributed to Jacopo de' Barbari",
		title: "Portrait of Fra Luca Pacioli and an Unknown Young Man",
		year: "1495",
		collection: "Museo di Capodimonte, Naples",
		commons: "https://commons.wikimedia.org/wiki/File:Pacioli.jpg",
		license: "Public domain (PD-Art, PD-old-100)",
	},
	syndics: {
		artist: "Rembrandt van Rijn",
		title: "The Syndics of the Drapers' Guild (De Staalmeesters)",
		year: "1662",
		collection: "Rijksmuseum, Amsterdam",
		commons:
			"https://commons.wikimedia.org/wiki/File:Rembrandt_-_De_Staalmeesters-_het_college_van_staalmeesters_(waardijns)_van_het_Amsterdamse_lakenbereidersgilde_-_Google_Art_Project.jpg",
		license: "Public domain (PD-Art, PD-old-100)",
	},
	moneylender: {
		artist: "Quentin Matsys",
		title: "The Moneylender and His Wife",
		year: "1514",
		collection: "Musée du Louvre, Paris",
		commons: "https://commons.wikimedia.org/wiki/File:Massysm_Quentin_%E2%80%94_The_Moneylender_and_his_Wife_%E2%80%94_1514.jpg",
		license: "Public domain (PD-Art, Yorck Project)",
	},
	taxcollectors: {
		artist: "After Marinus van Reymerswaele",
		title: "Tax Collectors",
		year: "1600 to 1649",
		collection: "National Museum in Warsaw",
		commons:
			"https://commons.wikimedia.org/wiki/File:Marinus_Claeszoon_van_Reymerswaele_-_Tax_collectors_-_M.Ob.592_MNW_-_National_Museum_in_Warsaw.jpg",
		license: "Public domain (PD-Art, PD-old)",
	},
	gisze: {
		artist: "Hans Holbein the Younger",
		title: "Portrait of the Merchant Georg Gisze",
		year: "1532",
		collection: "Gemäldegalerie, Berlin",
		commons:
			"https://commons.wikimedia.org/wiki/File:Hans_Holbein_der_J%C3%BCngere_-_Der_Kaufmann_Georg_Gisze_-_Google_Art_Project.jpg",
		license: "Public domain (PD-Art, PD-old-100)",
	},
};

const PIECES = [
	{
		name: "syndics",
		source: "syndics",
		crop: null,
		widths: [1200, 2000],
		jpg: 1600,
		alt: "Rembrandt's Syndics of the Drapers' Guild: five officials in black hats at a table with an open book, looking up as if interrupted, and a servant behind them.",
	},
	{
		name: "moneylender",
		source: "moneylender",
		crop: { left: 300, top: 270, width: 700, height: 1080 },
		widths: [480, 800],
		jpg: 640,
		alt: "Detail of Matsys's Moneylender: a man in a green turban weighing coins on a small balance.",
	},
	{
		name: "taxcollectors",
		source: "taxcollectors",
		crop: { left: 0, top: 640, width: 1920, height: 1741 },
		widths: [600, 1000],
		jpg: 800,
		alt: "Detail of Tax Collectors after Reymerswaele: one man writes in an account book while the other points at the entry.",
	},
	{
		name: "gisze",
		source: "gisze",
		crop: { left: 200, top: 150, width: 1720, height: 1900 },
		widths: [600, 1000],
		jpg: 800,
		alt: "Holbein's merchant Georg Gisze at his desk, opening a letter, with scales, papers and a ledger on the shelves behind him.",
	},
];

const FACES = [
	{ source: "pacioli", box: [575, 95, 310] },
	{ source: "gisze", box: [870, 330, 470] },
	{ source: "syndics", box: [127, 900, 423] },
	{ source: "syndics", box: [1010, 710, 423] },
	{ source: "syndics", box: [1432, 1018, 423] },
	{ source: "syndics", box: [1805, 730, 423] },
	{ source: "syndics", box: [2054, 1018, 423] },
	{ source: "syndics", box: [2880, 940, 423] },
	{ source: "moneylender", box: [470, 455, 285] },
	{ source: "moneylender", box: [975, 505, 285] },
	{ source: "taxcollectors", box: [450, 860, 520] },
	{ source: "taxcollectors", box: [1085, 715, 520] },
	{ source: "pacioli", box: [1085, 55, 290] },
];

const PALETTE = {
	ink: [17, 22, 21],
	teal: [12, 52, 51],
	tealDeep: [7, 31, 30],
	sage: [185, 211, 205],
	paper: [244, 241, 234],
	orange: [255, 79, 0],
};

const BAYER = [
	[0, 32, 8, 40, 2, 34, 10, 42],
	[48, 16, 56, 24, 50, 18, 58, 26],
	[12, 44, 4, 36, 14, 46, 6, 38],
	[60, 28, 52, 20, 62, 30, 54, 22],
	[3, 35, 11, 43, 1, 33, 9, 41],
	[51, 19, 59, 27, 49, 17, 57, 25],
	[15, 47, 7, 39, 13, 45, 5, 37],
	[63, 31, 55, 23, 61, 29, 53, 21],
];

function threshold(x, y, cell) {
	return (BAYER[Math.floor(y / cell) % 8][Math.floor(x / cell) % 8] + 0.5) / 64;
}

function wrap(text, width) {
	const words = text.split(" ");
	const lines = [];
	let line = "";
	for (const word of words) {
		if (line === "") line = word;
		else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
		else {
			lines.push(line);
			line = word;
		}
		while (line.length > width) {
			lines.push(line.slice(0, width));
			line = line.slice(width);
		}
	}
	if (line) lines.push(line);
	return lines;
}

function esc(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatFlag(claim) {
	const quote = claim.text.length > 120 ? `${claim.text.slice(0, 117)}...` : claim.text;
	const ref = claim.ref ? ` ${claim.ref}` : "";
	const label = claim.verdict === "contradicted" ? "FALSE CLAIM" : "UNSUPPORTED CLAIM";
	return `[${label}] ${claim.kind}${ref} | model said: "${quote}" | evidence: ${claim.reason}`;
}

function terminalContent() {
	const traces = JSON.parse(readFileSync(join(site, "src", "data", "traces.json"), "utf8"));
	const trace = traces.find((t) => t.session === "readonly-config__llama3.1-8b__prose__s2");
	const tool = trace.steps.find((s) => s.kind === "tool");
	const check = trace.steps.find((s) => s.kind === "check" && s.claims.length > 0);
	const claim = check.claims.find((c) => c.kind === "file_created");
	return {
		title: `ledger · ${trace.scenario} · ${trace.model}`,
		tool: `Write ${tool.input.path}`,
		output: tool.output,
		said: claim.text,
		flag: formatFlag(claim),
	};
}

async function terminalLayer(width, height) {
	const content = terminalContent();
	const pad = 22;
	const font = 17;
	const lh = 25;
	const chars = Math.floor((width - pad * 2) / (font * 0.602));
	const rows = [];
	rows.push({ text: `● ${content.tool}`, color: "paper", weight: 700 });
	for (const l of wrap(content.output, chars - 2)) rows.push({ text: `  ${l}`, color: "sage", weight: 400 });
	rows.push({ text: "", color: "paper" });
	for (const l of wrap(content.said, chars)) rows.push({ text: l, color: "paper", weight: 400 });
	rows.push({ text: "", color: "paper" });
	const flagLines = wrap(content.flag, chars);
	flagLines.forEach((l, i) => rows.push({ text: l, color: i === 0 ? "orange" : "sage", weight: i === 0 ? 700 : 400 }));

	const barH = 34;
	const colors = { paper: "rgb(244,241,234)", sage: "rgb(185,211,205)", orange: "rgb(255,79,0)" };
	const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<style>text{font-family:Menlo,'DejaVu Sans Mono',monospace;font-size:${font}px}</style>
<text x="${pad}" y="${barH - 11}" fill="rgb(17,22,21)" font-weight="700">${esc(content.title)}</text>
${rows
	.map(
		(r, i) =>
			`<text x="${pad}" y="${barH + pad + 4 + i * lh}" fill="${colors[r.color]}" font-weight="${r.weight ?? 400}" xml:space="preserve">${esc(r.text)}</text>`,
	)
	.join("\n")}
</svg>`;
	const needed = barH + pad + rows.length * lh + pad;
	return { textSvg: Buffer.from(textSvg), needed, barH };
}

function ditherWindow(width, height, barH, glow) {
	const W = width + glow * 2;
	const H = height + glow * 2;
	const buf = Buffer.alloc(W * H * 4);
	const cell = 2;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const wx = x - glow;
			const wy = y - glow;
			const t = threshold(x, y, cell);
			const inside = wx >= 0 && wy >= 0 && wx < width && wy < height;
			let color = null;
			let alpha = 0;
			if (inside) {
				const border = wx < 2 || wy < 2 || wx >= width - 2 || wy >= height - 2;
				if (border) {
					color = PALETTE.sage;
				} else if (wy < barH) {
					const level = 0.86 - (wx / width) * 0.22;
					color = t < level ? PALETTE.orange : PALETTE.ink;
				} else {
					const v = 0.1 + 0.2 * ((wy - barH) / (height - barH)) ** 1.4;
					color = t < v ? PALETTE.teal : PALETTE.tealDeep;
					if (t < v * 0.35) color = PALETTE.sage.map((c, k) => Math.round(c * 0.45 + PALETTE.teal[k] * 0.55));
				}
				alpha = 255;
			} else {
				const dx = Math.max(-wx, 0, wx - width + 1);
				const dy = Math.max(-wy, 0, wy - height + 1);
				const d = Math.hypot(dx, dy);
				const level = Math.max(0, 1 - d / glow) ** 2 * 0.55;
				if (t < level) {
					color = PALETTE.orange;
					alpha = 255;
				}
			}
			if (color) {
				buf[i] = color[0];
				buf[i + 1] = color[1];
				buf[i + 2] = color[2];
				buf[i + 3] = alpha;
			}
		}
	}
	return { buf, W, H };
}

async function composite() {
	const src = join(rawDir, "pacioli.jpg");
	const crop = { left: 0, top: 30, width: 990, height: 1220 };
	const win = { x: 14, y: 96, width: 566 };
	const probe = await terminalLayer(win.width, 600);
	const height = probe.needed;
	const { textSvg, barH } = await terminalLayer(win.width, height);
	const glow = 26;
	const { buf, W, H } = ditherWindow(win.width, height, barH, glow);
	const ring = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="9" fill="none" stroke="rgb(185,211,205)" stroke-width="3"/></svg>`,
	);
	const base = sharp(src).extract(crop);
	const winTop = win.y - crop.top;
	const out = await base
		.composite([
			{ input: buf, raw: { width: W, height: H, channels: 4 }, left: win.x - glow, top: winTop - glow },
			{ input: textSvg, left: win.x, top: winTop },
			{ input: ring, left: 237 - 20, top: winTop - 30 },
		])
		.toBuffer();
	const meta = { width: crop.width, height: crop.height };
	const files = await writeSizes("pacioli-terminal", sharp(out), [560, 990], 760);
	return {
		name: "pacioli-terminal",
		...meta,
		files,
		alt: "Detail of the Portrait of Fra Luca Pacioli. Where the glass polyhedron hangs from its string, a terminal window has been composited in, drawn in an orange and teal dither. It shows a Write to config/app.json failing with EACCES, the model saying the file was created, and Ledger's FALSE CLAIM flag.",
		source: "pacioli",
		terminal: terminalContent(),
	};
}

async function writeSizes(name, image, widths, jpgWidth) {
	const meta = await image.metadata();
	const files = { webp: [], jpg: "" };
	for (const w of widths) {
		const file = `${name}-${w}.webp`;
		await image.clone().resize({ width: Math.min(w, meta.width) }).webp({ quality: 78, effort: 6 }).toFile(join(outDir, file));
		files.webp.push({ file, width: Math.min(w, meta.width) });
	}
	const jpg = `${name}-${jpgWidth}.jpg`;
	await image
		.clone()
		.resize({ width: Math.min(jpgWidth, meta.width) })
		.jpeg({ quality: 76, mozjpeg: true })
		.toFile(join(outDir, jpg));
	files.jpg = jpg;
	return files;
}

async function main() {
	mkdirSync(outDir, { recursive: true });
	const manifest = { sources: {}, pieces: {}, faces: [] };

	const only = process.argv.find((a) => a.startsWith("--only="));
	const wanted = only ? only.slice(7).split(",") : PIECES.map((p) => p.name);
	for (const piece of PIECES.filter((p) => wanted.includes(p.name))) {
		let image = sharp(join(rawDir, `${piece.source}.jpg`));
		if (piece.crop) image = image.extract(piece.crop);
		const buffer = await image.toBuffer();
		const meta = await sharp(buffer).metadata();
		const files = await writeSizes(piece.name, sharp(buffer), piece.widths, piece.jpg);
		manifest.pieces[piece.name] = {
			name: piece.name,
			width: meta.width,
			height: meta.height,
			files,
			alt: piece.alt,
			source: piece.source,
		};
	}

	if (process.argv.includes("--composite")) manifest.pieces["pacioli-terminal"] = await composite();

	if (process.argv.includes("--faces")) {
		let n = 0;
		for (const face of FACES) {
			n += 1;
			const [left, top, size] = face.box;
			const file = `face-${String(n).padStart(2, "0")}`;
			const img = sharp(join(rawDir, `${face.source}.jpg`)).extract({ left, top, width: size, height: size }).resize(220, 220);
			await img.clone().webp({ quality: 74, effort: 6 }).toFile(join(outDir, `${file}.webp`));
			await img.clone().jpeg({ quality: 72, mozjpeg: true }).toFile(join(outDir, `${file}.jpg`));
			manifest.faces.push({ webp: `${file}.webp`, jpg: `${file}.jpg`, source: face.source });
		}
	}

	for (const p of Object.values(manifest.pieces)) manifest.sources[p.source] = SOURCES[p.source];
	writeFileSync(dataFile, `${JSON.stringify(manifest, null, "\t")}\n`);

	const credits = [
		"# Painting credits",
		"",
		"Every painting on this site is in the public domain. Files came from Wikimedia Commons, where each file page carries a PD-Art (or PD-Art Yorck Project) licence tag. They were resized, cropped and compressed by `scripts/prepare-art.mjs`.",
		"",
		...Object.entries(SOURCES)
			.filter(([key]) => Object.values(manifest.pieces).some((p) => p.source === key))
			.map(([, s]) => s)
			.map(
			(s) => `- ${s.artist}, *${s.title}*, ${s.year}. ${s.collection}. ${s.license}. ${s.commons}`,
		),
		"",
		"",
	].join("\n");
	writeFileSync(join(outDir, "CREDITS.md"), credits);
	process.stdout.write(`wrote ${Object.keys(manifest.pieces).length} pieces and ${manifest.faces.length} faces to public/art\n`);
}

main();

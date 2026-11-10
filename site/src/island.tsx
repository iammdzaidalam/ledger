import { createRoot, hydrateRoot } from "react-dom/client";
import { Page } from "./page/Page";
import { HeroDemo } from "./page/HeroDemo";
import { ReplayApp } from "./page/ReplayApp";
import { readInitial } from "./lib/sandbox";
import "./copy";
import "./page.css";
import "./app.css";

const initial = readInitial();

if (document.getElementById("hero-island")?.hasChildNodes()) {
	const hero = document.getElementById("hero-island");
	if (hero) hydrateRoot(hero, <HeroDemo initial={initial} />, { identifierPrefix: "hd" });
	const replay = document.getElementById("replay-island");
	if (replay) hydrateRoot(replay, <ReplayApp />);
} else {
	const root = document.getElementById("page");
	if (root) createRoot(root).render(<Page html={{ initial }} />);
}

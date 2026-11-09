import { createRoot, hydrateRoot } from "react-dom/client";
import { Page } from "./page/Page";
import { ReplayApp } from "./page/ReplayApp";
import "./page.css";

const island = document.getElementById("replay-island");
if (island) {
	hydrateRoot(island, <ReplayApp />);
} else {
	const root = document.getElementById("page");
	if (root) createRoot(root).render(<Page />);
}

document.addEventListener("click", (event) => {
	const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-copy]");
	if (!button) return;
	const text = button.dataset.copy ?? "";
	const label = button.textContent;
	navigator.clipboard
		.writeText(text)
		.then(() => {
			button.textContent = "Copied";
			window.setTimeout(() => {
				button.textContent = label;
			}, 1600);
		})
		.catch(() => undefined);
});

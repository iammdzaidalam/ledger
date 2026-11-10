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

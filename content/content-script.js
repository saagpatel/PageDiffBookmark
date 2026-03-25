/* global Readability */

// This script is injected programmatically via chrome.scripting.executeScript.
// Readability.js is injected before this script, so the Readability class is available.

(async () => {
	// 500ms delay for SPA resilience — let dynamic content finish rendering
	await new Promise((resolve) => setTimeout(resolve, 500));

	try {
		// Clone the document to avoid mutating the live page
		const docClone = document.cloneNode(true);
		const reader = new Readability(docClone);
		const article = reader.parse();

		let title = document.title;
		let textContent = "";

		if (
			article &&
			article.textContent &&
			article.textContent.trim().length > 0
		) {
			title = article.title || document.title;
			textContent = article.textContent.trim();
		} else {
			// Fallback: raw innerText (noisier but always works)
			textContent = document.body.innerText.trim();
		}

		return {
			title,
			textContent,
			url: location.href,
		};
	} catch (err) {
		// Fallback on any Readability error
		console.error(
			"[PDB Content Script] Readability error, using fallback:",
			err,
		);
		return {
			title: document.title,
			textContent: document.body.innerText.trim(),
			url: location.href,
		};
	}
})();

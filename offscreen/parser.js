/* global Readability */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (
		message.type !== "parse-fetched-html" ||
		message.target !== "offscreen-parser"
	) {
		return false;
	}

	try {
		const document = new DOMParser().parseFromString(message.html, "text/html");
		const article = new Readability(document).parse();
		const textContent =
			article?.textContent?.trim() || document.body?.textContent?.trim() || "";
		sendResponse({
			success: textContent.length > 0,
			title: article?.title || document.title || "",
			textContent,
			url: message.url,
			error: textContent.length > 0 ? null : "No readable content found",
		});
	} catch (error) {
		sendResponse({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return true;
});

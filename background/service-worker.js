/* global diff_match_patch */

importScripts("lib/diff-match-patch.js");

// ── Dev helpers (disable before shipping) ──────────────────────────
const DEV_POLL_INTERVAL_MINUTES = 1;

// ── Constants ──────────────────────────────────────────────────────
const STORAGE_KEYS = {
	bookmarks: "pdb_bookmarks",
	settings: "pdb_settings",
	snapshotPrefix: "pdb_snapshot_",
	diffPrefix: "pdb_diff_",
	activeDiffId: "pdb_active_diff_id",
};

const DEFAULT_SETTINGS = {
	defaultPollIntervalHours: 6,
	notificationsEnabled: true,
	badgeEnabled: true,
	maxBookmarks: 100,
};

// ── Install handler ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
	// Initialize settings (only if not already set)
	const { [STORAGE_KEYS.settings]: existing } = await chrome.storage.local.get(
		STORAGE_KEYS.settings,
	);
	if (!existing) {
		await chrome.storage.local.set({
			[STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
		});
	}

	// Initialize bookmarks array if missing
	const { [STORAGE_KEYS.bookmarks]: bookmarks } =
		await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
	if (!bookmarks) {
		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: [] });
	}

	// Clear existing menu items (prevents duplicate error on reload/update)
	await chrome.contextMenus.removeAll();
	chrome.contextMenus.create({
		id: "track-page",
		title: "Track this page",
		contexts: ["page"],
	});
});

// ── Context menu handler ───────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId !== "track-page" || !tab?.id) return;
	await trackPage(tab);
});

// ── Message handler ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type === "track-current-page") {
		handleTrackCurrentPage().then(sendResponse);
		return true; // async response
	}

	if (message.type === "delete-bookmark") {
		deleteBookmark(message.bookmarkId).then(sendResponse);
		return true;
	}

	if (message.type === "get-bookmarks") {
		getBookmarks().then(sendResponse);
		return true;
	}
});

// ── Core functions ─────────────────────────────────────────────────

/**
 * Track the current active tab — called from popup "Track Page" button.
 * @returns {{ success: boolean, error?: string }}
 */
async function handleTrackCurrentPage() {
	try {
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		if (!tab?.id) return { success: false, error: "No active tab found" };
		return await trackPage(tab);
	} catch (err) {
		console.error("[PDB] handleTrackCurrentPage error:", err);
		return { success: false, error: err.message };
	}
}

/**
 * Inject content script, extract content, create bookmark + snapshot.
 * @param {chrome.tabs.Tab} tab
 * @returns {{ success: boolean, error?: string }}
 */
async function trackPage(tab) {
	try {
		// Check URL is injectable
		if (
			!tab.url ||
			tab.url.startsWith("chrome://") ||
			tab.url.startsWith("chrome-extension://") ||
			tab.url.startsWith("chrome-search://") ||
			tab.url.startsWith("about:")
		) {
			return { success: false, error: "This page can't be tracked" };
		}

		// Check for duplicate URL
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		if (bookmarks.some((b) => b.url === tab.url)) {
			return { success: false, error: "Already tracking this page" };
		}

		// Check max bookmarks
		const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		if (bookmarks.length >= settings.maxBookmarks) {
			return {
				success: false,
				error: `Maximum of ${settings.maxBookmarks} bookmarks reached`,
			};
		}

		// Inject Readability + content script, get extraction result
		const extraction = await injectAndExtract(tab.id);
		if (!extraction) {
			return { success: false, error: "Failed to extract page content" };
		}

		// Create bookmark
		const id = crypto.randomUUID();
		const now = Date.now();

		/** @type {Bookmark} */
		const bookmark = {
			id,
			url: tab.url,
			title: extraction.title || tab.title || "Untitled",
			favicon: tab.favIconUrl || "",
			addedAt: now,
			lastChecked: 0,
			lastChanged: 0,
			pollIntervalHours: settings.defaultPollIntervalHours,
			paused: false,
			hasUnreadDiff: false,
			changeCount: 0,
		};

		/** @type {Snapshot} */
		const snapshot = {
			bookmarkId: id,
			extractedText: extraction.textContent,
			capturedAt: now,
			sentenceCount: countSentences(extraction.textContent),
		};

		// Write to storage
		bookmarks.push(bookmark);
		await chrome.storage.local.set({
			[STORAGE_KEYS.bookmarks]: bookmarks,
			[`${STORAGE_KEYS.snapshotPrefix}${id}`]: snapshot,
		});

		return { success: true };
	} catch (err) {
		console.error("[PDB] trackPage error:", err);
		return { success: false, error: err.message };
	}
}

/**
 * Inject Readability.js + content-script.js into a tab and return extraction.
 * @param {number} tabId
 * @returns {Promise<{title: string, textContent: string, url: string} | null>}
 */
async function injectAndExtract(tabId) {
	try {
		// Inject Readability.js first so it's available in the page context
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ["lib/Readability.js"],
		});

		// Use func (not files) so Chrome properly awaits the async return value
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			func: extractPageContent,
		});

		const result = results?.[0]?.result;
		if (!result || !result.textContent) return null;
		return result;
	} catch (err) {
		console.error("[PDB] injectAndExtract error:", err);
		return null;
	}
}

/**
 * Runs in the page context via chrome.scripting.executeScript({ func }).
 * Readability.js must be injected before this runs.
 */
async function extractPageContent() {
	// 500ms delay for SPA resilience — let dynamic content finish rendering
	await new Promise((resolve) => setTimeout(resolve, 500));

	try {
		const docClone = document.cloneNode(true);
		// Pass documentURI so Readability can resolve relative URLs correctly
		const reader = new Readability(docClone, { url: location.href });
		const article = reader.parse();

		let title = document.title;
		let textContent = "";

		if (article?.textContent?.trim().length > 0) {
			title = article.title || document.title;
			textContent = article.textContent.trim();
		} else {
			// Fallback: raw innerText (noisier but always works)
			textContent = document.body.innerText.trim();
		}

		return { title, textContent, url: location.href };
	} catch {
		// Fallback on any Readability error
		return {
			title: document.title,
			textContent: document.body.innerText.trim(),
			url: location.href,
		};
	}
}

/**
 * Delete a bookmark and its associated snapshot + diff.
 * @param {string} bookmarkId
 * @returns {{ success: boolean }}
 */
async function deleteBookmark(bookmarkId) {
	try {
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const filtered = bookmarks.filter((b) => b.id !== bookmarkId);

		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: filtered });
		await chrome.storage.local.remove([
			`${STORAGE_KEYS.snapshotPrefix}${bookmarkId}`,
			`${STORAGE_KEYS.diffPrefix}${bookmarkId}`,
		]);

		// Update badge
		await updateBadge(filtered);

		return { success: true };
	} catch (err) {
		console.error("[PDB] deleteBookmark error:", err);
		return { success: false };
	}
}

/**
 * Get all bookmarks from storage.
 * @returns {Promise<Bookmark[]>}
 */
async function getBookmarks() {
	const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
		await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
	return bookmarks;
}

// ── Utilities ──────────────────────────────────────────────────────

/**
 * Count sentences by splitting on period/exclamation/question + whitespace.
 * @param {string} text
 * @returns {number}
 */
function countSentences(text) {
	if (!text) return 0;
	const sentences = text.split(/[.!?]+\s+/).filter((s) => s.trim().length > 0);
	return sentences.length;
}

/**
 * Update the extension badge with unread diff count.
 * @param {Bookmark[]} bookmarks
 */
async function updateBadge(bookmarks) {
	const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
		await chrome.storage.local.get(STORAGE_KEYS.settings);

	if (!settings.badgeEnabled) {
		await chrome.action.setBadgeText({ text: "" });
		return;
	}

	const unreadCount = bookmarks.filter((b) => b.hasUnreadDiff).length;
	await chrome.action.setBadgeText({
		text: unreadCount > 0 ? String(unreadCount) : "",
	});
	await chrome.action.setBadgeBackgroundColor({ color: "#E53E3E" });
}

// ── Dev debug namespace ────────────────────────────────────────────
// Access from service worker console: pdebug.listBookmarks()
self.pdebug = {
	async listBookmarks() {
		const bm = await getBookmarks();
		console.table(bm);
		return bm;
	},
	async clearAllStorage() {
		await chrome.storage.local.clear();
		console.log("[PDB] All storage cleared");
	},
	async getSnapshot(id) {
		const key = `${STORAGE_KEYS.snapshotPrefix}${id}`;
		const data = await chrome.storage.local.get(key);
		console.log(data[key]);
		return data[key];
	},
};

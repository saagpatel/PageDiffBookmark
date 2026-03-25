/* global diff_match_patch, Readability */

importScripts("lib/diff-match-patch.js");
importScripts("lib/Readability.js");

// ── Dev helpers (set to 0 for production) ──────────────────────────
const DEV_POLL_INTERVAL_MINUTES = 1; // 0 = use bookmark's configured interval

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

	// Re-register alarms for all non-paused bookmarks (alarms don't survive SW restart)
	const allBookmarks = bookmarks || [];
	for (const bm of allBookmarks) {
		if (!bm.paused) {
			registerAlarm(bm.id, bm.pollIntervalHours);
		}
	}
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

	if (message.type === "pause-bookmark") {
		pauseBookmark(message.bookmarkId).then(sendResponse);
		return true;
	}

	if (message.type === "resume-bookmark") {
		resumeBookmark(message.bookmarkId).then(sendResponse);
		return true;
	}

	if (message.type === "set-poll-interval") {
		setPollInterval(message.bookmarkId, message.hours).then(sendResponse);
		return true;
	}

	if (message.type === "check-now") {
		pollBookmark(message.bookmarkId).then(() =>
			sendResponse({ success: true }),
		);
		return true;
	}

	if (message.type === "get-diff") {
		getDiffResult(message.bookmarkId).then(sendResponse);
		return true;
	}

	if (message.type === "mark-diff-read") {
		markDiffRead(message.bookmarkId).then(sendResponse);
		return true;
	}

	if (message.type === "update-settings") {
		updateSettings(message.settings).then(sendResponse);
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

		// Register polling alarm
		registerAlarm(id, bookmark.pollIntervalHours);

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

		// Clear polling alarm
		await chrome.alarms.clear(`poll_${bookmarkId}`);

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

/**
 * Pause a bookmark — stop polling.
 * @param {string} bookmarkId
 */
async function pauseBookmark(bookmarkId) {
	try {
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const bookmark = bookmarks.find((b) => b.id === bookmarkId);
		if (!bookmark) return { success: false };

		bookmark.paused = true;
		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
		await chrome.alarms.clear(`poll_${bookmarkId}`);
		return { success: true };
	} catch (err) {
		console.error("[PDB] pauseBookmark error:", err);
		return { success: false };
	}
}

/**
 * Resume a bookmark — restart polling.
 * @param {string} bookmarkId
 */
async function resumeBookmark(bookmarkId) {
	try {
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const bookmark = bookmarks.find((b) => b.id === bookmarkId);
		if (!bookmark) return { success: false };

		bookmark.paused = false;
		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
		registerAlarm(bookmarkId, bookmark.pollIntervalHours);
		return { success: true };
	} catch (err) {
		console.error("[PDB] resumeBookmark error:", err);
		return { success: false };
	}
}

/**
 * Change a bookmark's poll interval.
 * @param {string} bookmarkId
 * @param {number} hours
 */
async function setPollInterval(bookmarkId, hours) {
	try {
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const bookmark = bookmarks.find((b) => b.id === bookmarkId);
		if (!bookmark) return { success: false };

		bookmark.pollIntervalHours = hours;
		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });

		if (!bookmark.paused) {
			await chrome.alarms.clear(`poll_${bookmarkId}`);
			registerAlarm(bookmarkId, hours);
		}
		return { success: true };
	} catch (err) {
		console.error("[PDB] setPollInterval error:", err);
		return { success: false };
	}
}

/**
 * Get a diff result from storage.
 * @param {string} bookmarkId
 */
async function getDiffResult(bookmarkId) {
	try {
		const key = `${STORAGE_KEYS.diffPrefix}${bookmarkId}`;
		const data = await chrome.storage.local.get(key);
		return data[key] || null;
	} catch (err) {
		console.error("[PDB] getDiffResult error:", err);
		return null;
	}
}

/**
 * Mark a bookmark's diff as read.
 * @param {string} bookmarkId
 */
async function markDiffRead(bookmarkId) {
	try {
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const bookmark = bookmarks.find((b) => b.id === bookmarkId);
		if (!bookmark) return { success: false };

		bookmark.hasUnreadDiff = false;
		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
		await updateBadge(bookmarks);
		return { success: true };
	} catch (err) {
		console.error("[PDB] markDiffRead error:", err);
		return { success: false };
	}
}

/**
 * Update global settings.
 * @param {object} newSettings — partial settings to merge
 */
async function updateSettings(newSettings) {
	try {
		const { [STORAGE_KEYS.settings]: current = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		const merged = { ...current, ...newSettings };
		await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });

		// Reapply badge visibility
		const bookmarks = await getBookmarks();
		await updateBadge(bookmarks);
		return { success: true };
	} catch (err) {
		console.error("[PDB] updateSettings error:", err);
		return { success: false };
	}
}

// ── Polling engine ─────────────────────────────────────────────────

/**
 * Register a periodic alarm for a bookmark.
 * @param {string} bookmarkId
 * @param {number} pollIntervalHours
 */
function registerAlarm(bookmarkId, pollIntervalHours) {
	const periodInMinutes =
		DEV_POLL_INTERVAL_MINUTES > 0
			? DEV_POLL_INTERVAL_MINUTES
			: pollIntervalHours * 60;
	chrome.alarms.create(`poll_${bookmarkId}`, {
		delayInMinutes: periodInMinutes,
		periodInMinutes,
	});
}

/**
 * Alarm handler — routes poll alarms to the poll cycle.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
	if (!alarm.name.startsWith("poll_")) return;
	const bookmarkId = alarm.name.slice(5); // strip "poll_"
	await pollBookmark(bookmarkId);
});

/**
 * Poll a single bookmark: fetch → extract → diff → notify.
 * @param {string} bookmarkId
 */
async function pollBookmark(bookmarkId) {
	try {
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const bookmark = bookmarks.find((b) => b.id === bookmarkId);
		if (!bookmark || bookmark.paused) return;

		const snapshotKey = `${STORAGE_KEYS.snapshotPrefix}${bookmarkId}`;
		const { [snapshotKey]: storedSnapshot } =
			await chrome.storage.local.get(snapshotKey);
		if (!storedSnapshot) return;

		// Fetch and extract current page content
		const extraction = await fetchAndExtract(bookmark.url);
		const now = Date.now();

		// Always update lastChecked
		bookmark.lastChecked = now;

		if (!extraction) {
			// Fetch failed — just update lastChecked, don't fire notification
			console.warn(`[PDB] Poll failed for "${bookmark.title}" — fetch error`);
			await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
			return;
		}

		// Auth wall detection: if new content is <20% of stored sentence count, skip
		const newSentenceCount = countSentences(extraction.textContent);
		if (
			storedSnapshot.sentenceCount > 10 &&
			newSentenceCount < storedSnapshot.sentenceCount * 0.2
		) {
			console.warn(
				`[PDB] Suspected auth wall for "${bookmark.title}" — ` +
					`${newSentenceCount} vs ${storedSnapshot.sentenceCount} sentences, skipping`,
			);
			await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
			return;
		}

		// Compute diff
		const diffResult = computeDiff(
			storedSnapshot.extractedText,
			extraction.textContent,
		);

		if (!diffResult) {
			// No changes detected
			console.log(`[PDB] No change detected for "${bookmark.title}"`);
			await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
			return;
		}

		// Change detected — update everything
		console.log(
			`[PDB] Change detected for "${bookmark.title}": ` +
				`+${diffResult.addedSentences} -${diffResult.removedSentences}`,
		);

		bookmark.hasUnreadDiff = true;
		bookmark.changeCount++;
		bookmark.lastChanged = now;

		const newSnapshot = {
			bookmarkId,
			extractedText: extraction.textContent,
			capturedAt: now,
			sentenceCount: newSentenceCount,
		};

		const diffRecord = {
			bookmarkId,
			detectedAt: now,
			addedSentences: diffResult.addedSentences,
			removedSentences: diffResult.removedSentences,
			htmlDiff: diffResult.htmlDiff,
			previousSentenceCount: storedSnapshot.sentenceCount,
			currentSentenceCount: newSentenceCount,
		};

		await chrome.storage.local.set({
			[STORAGE_KEYS.bookmarks]: bookmarks,
			[snapshotKey]: newSnapshot,
			[`${STORAGE_KEYS.diffPrefix}${bookmarkId}`]: diffRecord,
		});

		await updateBadge(bookmarks);

		// Fire OS notification
		const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		if (settings.notificationsEnabled) {
			await sendChangeNotification(bookmark, diffResult);
		}
	} catch (err) {
		console.error(`[PDB] pollBookmark error for ${bookmarkId}:`, err);
	}
}

/**
 * Fetch a URL and extract text content using DOMParser + Readability.
 * Runs entirely in the service worker — no tab needed.
 * @param {string} url
 * @returns {Promise<{title: string, textContent: string} | null>}
 */
async function fetchAndExtract(url) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);

		const resp = await fetch(url, {
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!resp.ok) {
			console.warn(`[PDB] Fetch returned ${resp.status} for ${url}`);
			return null;
		}

		const html = await resp.text();

		// Try DOMParser + Readability
		try {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const reader = new Readability(doc);
			const article = reader.parse();

			if (article?.textContent?.trim().length > 0) {
				return {
					title: article.title || "",
					textContent: article.textContent.trim(),
				};
			}

			// Readability returned empty — fall back to body text
			if (doc.body?.textContent?.trim().length > 0) {
				return {
					title: doc.title || "",
					textContent: doc.body.textContent.trim(),
				};
			}
		} catch (parseErr) {
			console.warn(
				"[PDB] DOMParser/Readability failed, using regex fallback:",
				parseErr,
			);
		}

		// Final fallback: regex strip HTML tags
		const stripped = html
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();

		if (stripped.length > 0) {
			return { title: "", textContent: stripped };
		}

		return null;
	} catch (err) {
		if (err.name === "AbortError") {
			console.warn(`[PDB] Fetch timeout for ${url}`);
		} else {
			console.error(`[PDB] fetchAndExtract error for ${url}:`, err);
		}
		return null;
	}
}

/**
 * Compute sentence-level diff between old and new text.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ htmlDiff: string, addedSentences: number, removedSentences: number } | null}
 */
function computeDiff(oldText, newText) {
	if (oldText === newText) return null;

	const dmp = new diff_match_patch();

	// Sentence-level: split on sentence boundaries, diff the joined result
	const oldSentences = splitSentences(oldText);
	const newSentences = splitSentences(newText);

	const oldJoined = oldSentences.join("\n");
	const newJoined = newSentences.join("\n");

	if (oldJoined === newJoined) return null;

	const diffs = dmp.diff_main(oldJoined, newJoined);
	dmp.diff_cleanupSemantic(diffs);

	let addedSentences = 0;
	let removedSentences = 0;
	const htmlParts = [];

	for (const [op, text] of diffs) {
		const escaped = escapeHtml(text);
		if (op === 1) {
			// DIFF_INSERT
			addedSentences += countSentencesInChunk(text);
			htmlParts.push(`<ins>${escaped}</ins>`);
		} else if (op === -1) {
			// DIFF_DELETE
			removedSentences += countSentencesInChunk(text);
			htmlParts.push(`<del>${escaped}</del>`);
		} else {
			htmlParts.push(escaped);
		}
	}

	if (addedSentences === 0 && removedSentences === 0) return null;

	// Truncate HTML to 50KB max
	let htmlDiff = htmlParts.join("");
	if (htmlDiff.length > 50000) {
		htmlDiff =
			htmlDiff.slice(0, 50000) +
			'<p style="color:#999;font-style:italic">Content truncated — re-check for full diff.</p>';
	}

	return { htmlDiff, addedSentences, removedSentences };
}

/**
 * Split text into sentences on period/exclamation/question + whitespace.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
	if (!text) return [];
	return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/**
 * Count sentence-ish boundaries in a diff chunk.
 * @param {string} text
 * @returns {number}
 */
function countSentencesInChunk(text) {
	const sentences = text.split(/\n/).filter((s) => s.trim().length > 0);
	return Math.max(1, sentences.length);
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Notifications ──────────────────────────────────────────────────

/**
 * Send an OS notification for a detected page change.
 * @param {object} bookmark
 * @param {{ addedSentences: number, removedSentences: number }} diffResult
 */
async function sendChangeNotification(bookmark, diffResult) {
	const notificationId = `notif_${bookmark.id}`;
	// favicon may be a data URI which chrome.notifications rejects — use extension icon
	const iconUrl =
		bookmark.favicon && bookmark.favicon.startsWith("http")
			? bookmark.favicon
			: chrome.runtime.getURL("icons/icon-128.png");

	await chrome.notifications.create(notificationId, {
		type: "basic",
		title: `Page changed: ${bookmark.title}`,
		message: `+${diffResult.addedSentences} / -${diffResult.removedSentences} sentences`,
		iconUrl,
	});
}

/**
 * Notification click → store active diff ID and focus the extension popup.
 * Note: chrome.sidePanel.open() requires a user gesture and notification
 * clicks don't qualify. Instead we store the diff ID so the side panel
 * picks it up when opened, and focus the browser window.
 */
chrome.notifications.onClicked.addListener(async (notificationId) => {
	if (!notificationId.startsWith("notif_")) return;
	const bookmarkId = notificationId.slice(6); // strip "notif_"

	// Store which diff to display — side panel reads this on open
	await chrome.storage.local.set({
		[STORAGE_KEYS.activeDiffId]: bookmarkId,
	});

	// Focus the last active window so the user can open the side panel
	try {
		const win = await chrome.windows.getLastFocused();
		if (win?.id) {
			await chrome.windows.update(win.id, { focused: true });
		}
	} catch (err) {
		console.error("[PDB] Failed to focus window:", err);
	}

	// Open the popup so the user sees the diff badge
	// (can't programmatically open side panel from non-gesture context)
	chrome.notifications.clear(notificationId);
});

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
	async getDiff(id) {
		const key = `${STORAGE_KEYS.diffPrefix}${id}`;
		const data = await chrome.storage.local.get(key);
		console.log(data[key]);
		return data[key];
	},
	async triggerPoll(bookmarkId) {
		console.log(`[PDB] Manually triggering poll for ${bookmarkId}`);
		await pollBookmark(bookmarkId);
	},
	async listAlarms() {
		const alarms = await chrome.alarms.getAll();
		console.table(alarms);
		return alarms;
	},
};

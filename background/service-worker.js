/* global diff_match_patch, ResearchCapture */

importScripts("../lib/diff-match-patch.js");
importScripts("research-capture.js");

// ── Dev helpers (set to 0 for production) ──────────────────────────
const DEV_POLL_INTERVAL_MINUTES = 0; // scheduling remains unarmed by default

// ── Constants ──────────────────────────────────────────────────────
const STORAGE_KEYS = {
	bookmarks: "pdb_bookmarks",
	settings: "pdb_settings",
	snapshotPrefix: "pdb_snapshot_",
	diffPrefix: "pdb_diff_",
	activeDiffId: "pdb_active_diff_id",
	researchPacketPrefix: "pdb_research_packet_",
	researchHistoryPrefix: "pdb_research_history_",
};

const DEFAULT_SETTINGS = {
	defaultPollIntervalHours: 6,
	notificationsEnabled: true,
	badgeEnabled: true,
	maxBookmarks: 100,
	automationArmed: false,
};

const OFFSCREEN_DOCUMENT_PATH = "offscreen/parser.html";
let offscreenCreating = null;
const researchPacketWrites = new Map();

function isAutomationArmed(settings) {
	return settings?.automationArmed === true;
}

function normalizeSettings(value) {
	const supplied =
		value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		...DEFAULT_SETTINGS,
		...supplied,
		defaultPollIntervalHours: isValidPollInterval(
			supplied.defaultPollIntervalHours,
		)
			? supplied.defaultPollIntervalHours
			: DEFAULT_SETTINGS.defaultPollIntervalHours,
		automationArmed: supplied.automationArmed === true,
	};
}

function isValidPollInterval(hours) {
	return typeof hours === "number" && Number.isFinite(hours) && hours > 0;
}

function hasCanonicalBookmark(bookmarks, targetUrl) {
	return bookmarks.some((bookmark) => {
		try {
			return ResearchCapture.canonicalizeUrl(bookmark.url) === targetUrl;
		} catch {
			return false;
		}
	});
}

// ── Install handler ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
	// Initialize settings (only if not already set)
	const { [STORAGE_KEYS.settings]: existing } = await chrome.storage.local.get(
		STORAGE_KEYS.settings,
	);
	const settings = normalizeSettings(existing);
	await chrome.storage.local.set({
		[STORAGE_KEYS.settings]: settings,
	});

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

	await reconcilePollingAlarms(bookmarks || [], isAutomationArmed(settings));
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
		pollBookmark(message.bookmarkId).then((result) => {
			if (result?.error) {
				sendResponse({ success: false, error: result.error });
				return;
			}
			sendResponse({ success: true, result });
		});
		return true;
	}

	if (message.type === "get-research-packets") {
		getResearchPackets(message.bookmarkId).then(sendResponse);
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

		// Reject unsupported or credential-bearing locators before page extraction.
		const requestedUrl = ResearchCapture.admitPublicSourceUrl(tab.url);

		// Check for a duplicate canonical URL before doing extraction work.
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		if (hasCanonicalBookmark(bookmarks, requestedUrl)) {
			return { success: false, error: "Already tracking this page" };
		}

		// Check max bookmarks
		const { [STORAGE_KEYS.settings]: storedSettings = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		const settings = normalizeSettings(storedSettings);
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
		const observedUrl = ResearchCapture.admitPublicSourceUrl(
			extraction.url || requestedUrl,
		);
		if (hasCanonicalBookmark(bookmarks, observedUrl)) {
			return { success: false, error: "Already tracking this page" };
		}

		// Create bookmark
		const id = crypto.randomUUID();
		const now = Date.now();

		/** @type {Bookmark} */
		const bookmark = {
			id,
			url: observedUrl,
			title: extraction.title || tab.title || "Untitled",
			favicon: tab.favIconUrl || "",
			addedAt: now,
			lastChecked: 0,
			lastChanged: 0,
			pollIntervalHours: settings.defaultPollIntervalHours,
			paused: false,
			hasUnreadDiff: false,
			changeCount: 0,
			sourceId: ResearchCapture.stableSourceId(observedUrl),
			sourceKind: "html_document",
			trust: "unknown",
			freshness: {
				max_age_hours: settings.defaultPollIntervalHours * 2,
				expected_update_pattern: "operator_registered_web_source",
			},
		};

		/** @type {Snapshot} */
		const snapshot = {
			bookmarkId: id,
			extractedText: extraction.textContent,
			capturedAt: now,
			sentenceCount: countSentences(extraction.textContent),
		};
		const researchPacket = await ResearchCapture.createPacket({
			bookmark,
			status: "observed",
			content: extraction.textContent,
			observedAt: now,
			responseStatus: null,
			extractionMethod: "readability_tab_injection",
		});

		// Write to storage
		bookmarks.push(bookmark);
		await chrome.storage.local.set({
			[STORAGE_KEYS.bookmarks]: bookmarks,
			[`${STORAGE_KEYS.snapshotPrefix}${id}`]: snapshot,
			[`${STORAGE_KEYS.researchPacketPrefix}${id}`]: researchPacket,
			[`${STORAGE_KEYS.researchHistoryPrefix}${id}`]: [researchPacket],
		});

		// Register polling alarm
		registerAlarm(
			id,
			bookmark.pollIntervalHours,
			isAutomationArmed(settings),
		);

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
		const pendingPacketWrite = researchPacketWrites.get(bookmarkId);
		if (pendingPacketWrite) {
			await pendingPacketWrite.catch(() => undefined);
		}
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const filtered = bookmarks.filter((b) => b.id !== bookmarkId);

		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: filtered });
		await chrome.storage.local.remove([
			`${STORAGE_KEYS.snapshotPrefix}${bookmarkId}`,
			`${STORAGE_KEYS.diffPrefix}${bookmarkId}`,
			`${STORAGE_KEYS.researchPacketPrefix}${bookmarkId}`,
			`${STORAGE_KEYS.researchHistoryPrefix}${bookmarkId}`,
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
		const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		registerAlarm(
			bookmarkId,
			bookmark.pollIntervalHours,
			isAutomationArmed(settings),
		);
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
		if (!isValidPollInterval(hours)) {
			return {
				success: false,
				error: "Polling interval must be a positive finite number",
			};
		}
		const { [STORAGE_KEYS.bookmarks]: bookmarks = [] } =
			await chrome.storage.local.get(STORAGE_KEYS.bookmarks);
		const bookmark = bookmarks.find((b) => b.id === bookmarkId);
		if (!bookmark) return { success: false };

		bookmark.pollIntervalHours = hours;
		await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });

		const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		await chrome.alarms.clear(`poll_${bookmarkId}`);
		if (!bookmark.paused && isAutomationArmed(settings)) {
			registerAlarm(bookmarkId, hours, true);
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
		if (
			!newSettings ||
			typeof newSettings !== "object" ||
			Array.isArray(newSettings)
		) {
			return { success: false, error: "Settings must be an object" };
		}
		if (
			Object.hasOwn(newSettings, "automationArmed") &&
			typeof newSettings.automationArmed !== "boolean"
		) {
			return {
				success: false,
				error: "automationArmed must be a boolean",
			};
		}
		if (
			Object.hasOwn(newSettings, "defaultPollIntervalHours") &&
			!isValidPollInterval(newSettings.defaultPollIntervalHours)
		) {
			return {
				success: false,
				error: "defaultPollIntervalHours must be a positive finite number",
			};
		}
		const { [STORAGE_KEYS.settings]: current = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		const merged = normalizeSettings({ ...current, ...newSettings });
		await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });

		const bookmarks = await getBookmarks();
		await reconcilePollingAlarms(bookmarks, isAutomationArmed(merged));
		// Reapply badge visibility.
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
function registerAlarm(bookmarkId, pollIntervalHours, automationArmed = false) {
	if (automationArmed !== true) return;
	if (!isValidPollInterval(pollIntervalHours)) return;
	const periodInMinutes =
		DEV_POLL_INTERVAL_MINUTES > 0
			? DEV_POLL_INTERVAL_MINUTES
			: pollIntervalHours * 60;
	chrome.alarms.create(`poll_${bookmarkId}`, {
		delayInMinutes: periodInMinutes,
		periodInMinutes,
	});
}

async function reconcilePollingAlarms(bookmarks, automationArmed) {
	const alarms = await chrome.alarms.getAll();
	await Promise.all(
		alarms
			.filter((alarm) => alarm.name.startsWith("poll_"))
			.map((alarm) => chrome.alarms.clear(alarm.name)),
	);
	if (automationArmed !== true) return;
	for (const bookmark of bookmarks) {
		if (!bookmark.paused) {
			registerAlarm(bookmark.id, bookmark.pollIntervalHours, true);
		}
	}
}

/**
 * Alarm handler — routes poll alarms to the poll cycle.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
	if (!alarm.name.startsWith("poll_")) return;
	const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
		await chrome.storage.local.get(STORAGE_KEYS.settings);
	if (!isAutomationArmed(settings)) {
		await chrome.alarms.clear(alarm.name);
		return;
	}
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
		let admittedUrl;
		try {
			admittedUrl = ResearchCapture.admitPublicSourceUrl(bookmark.url);
		} catch {
			await chrome.alarms.clear(`poll_${bookmarkId}`);
			return {
				error:
					"Stored source locator failed public polling admission; re-register the source",
			};
		}

		const snapshotKey = `${STORAGE_KEYS.snapshotPrefix}${bookmarkId}`;
		const { [snapshotKey]: storedSnapshot } =
			await chrome.storage.local.get(snapshotKey);
		if (!storedSnapshot) return;

		// Fetch and extract current page content
		const extraction = await fetchAndExtract(admittedUrl);
		const now = Date.now();

		// Always update lastChecked
		bookmark.lastChecked = now;

		if (!extraction?.ok) {
			const researchPacket = await ResearchCapture.createPacket({
				bookmark,
				status: extraction?.status || "inaccessible",
				content: null,
				observedAt: now,
				responseStatus: extraction?.responseStatus ?? null,
				retryAfterSeconds: extraction?.retryAfterSeconds ?? null,
				extractionWarnings: extraction?.warnings || ["fetch_error"],
				extractionMethod: "readability_service_worker",
			});
			console.warn(
				`[PDB] Poll failed for "${bookmark.title}" — ${researchPacket.status}`,
			);
			await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
			await persistResearchPacket(bookmarkId, researchPacket);
			return { researchPacket };
		}

		// Auth wall detection: if new content is <20% of stored sentence count, skip
		const newSentenceCount = countSentences(extraction.textContent);
		if (
			storedSnapshot.sentenceCount > 10 &&
			newSentenceCount < storedSnapshot.sentenceCount * 0.2
		) {
			const researchPacket = await ResearchCapture.createPacket({
				bookmark,
				status: "inaccessible",
				content: null,
				observedAt: now,
				responseStatus: extraction.responseStatus,
				extractionWarnings: ["suspected_auth_wall"],
				extractionMethod: "readability_service_worker",
			});
			console.warn(
				`[PDB] Suspected auth wall for "${bookmark.title}" — ` +
					`${newSentenceCount} vs ${storedSnapshot.sentenceCount} sentences, skipping`,
			);
			await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
			await persistResearchPacket(bookmarkId, researchPacket);
			return { researchPacket };
		}

		// Compute diff
		const diffResult = computeDiff(
			storedSnapshot.extractedText,
			extraction.textContent,
		);

		if (!diffResult) {
			// No changes detected
			console.log(`[PDB] No change detected for "${bookmark.title}"`);
			const researchPacket = await ResearchCapture.createPacket({
				bookmark,
				status: "observed",
				content: extraction.textContent,
				observedAt: now,
				responseStatus: extraction.responseStatus,
				extractionMethod: "readability_service_worker",
			});
			await chrome.storage.local.set({ [STORAGE_KEYS.bookmarks]: bookmarks });
			await persistResearchPacket(bookmarkId, researchPacket);
			return { researchPacket };
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

		const researchPacket = await ResearchCapture.createPacket({
			bookmark,
			status: "observed",
			content: extraction.textContent,
			observedAt: now,
			responseStatus: extraction.responseStatus,
			extractionMethod: "readability_service_worker",
			diff: diffResult,
		});
		await chrome.storage.local.set({
			[STORAGE_KEYS.bookmarks]: bookmarks,
			[snapshotKey]: newSnapshot,
			[`${STORAGE_KEYS.diffPrefix}${bookmarkId}`]: diffRecord,
		});
		await persistResearchPacket(bookmarkId, researchPacket);

		await updateBadge(bookmarks);

		// Fire OS notification
		const { [STORAGE_KEYS.settings]: settings = DEFAULT_SETTINGS } =
			await chrome.storage.local.get(STORAGE_KEYS.settings);
		if (settings.notificationsEnabled) {
			await sendChangeNotification(bookmark, diffResult);
		}
		return { researchPacket };
	} catch (err) {
		console.error(`[PDB] pollBookmark error for ${bookmarkId}:`, err);
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function persistResearchPacket(bookmarkId, researchPacket) {
	const previousWrite = researchPacketWrites.get(bookmarkId) || Promise.resolve();
	const currentWrite = previousWrite.catch(() => undefined).then(async () => {
		const currentKey = `${STORAGE_KEYS.researchPacketPrefix}${bookmarkId}`;
		const historyKey = `${STORAGE_KEYS.researchHistoryPrefix}${bookmarkId}`;
		const { [historyKey]: packetHistory = [] } =
			await chrome.storage.local.get(historyKey);
		const boundedHistory = ResearchCapture.appendToHistory(
			packetHistory,
			researchPacket,
		);
		await chrome.storage.local.set({
			[currentKey]: researchPacket,
			[historyKey]: boundedHistory,
		});
	});
	researchPacketWrites.set(bookmarkId, currentWrite);
	try {
		await currentWrite;
	} finally {
		if (researchPacketWrites.get(bookmarkId) === currentWrite) {
			researchPacketWrites.delete(bookmarkId);
		}
	}
}

async function getResearchPackets(bookmarkId) {
	const currentKey = `${STORAGE_KEYS.researchPacketPrefix}${bookmarkId}`;
	const historyKey = `${STORAGE_KEYS.researchHistoryPrefix}${bookmarkId}`;
	const values = await chrome.storage.local.get([currentKey, historyKey]);
	return {
		current: values[currentKey] || null,
		history: values[historyKey] || [],
	};
}

/**
 * Fetch a URL in the service worker and parse it in an offscreen DOM document.
 * No visible browser tab is needed.
 * @param {string} url
 * @returns {Promise<object>}
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
			const retryAfter = resp.headers.get("retry-after");
			const parsedRetryAfter = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
			return {
				ok: false,
				status:
					resp.status === 429
						? "rate_limited"
						: resp.status === 404 || resp.status === 410
							? "deleted"
							: "inaccessible",
				responseStatus: resp.status,
				retryAfterSeconds: Number.isFinite(parsedRetryAfter)
					? parsedRetryAfter
					: null,
				warnings: [`http_${resp.status}`],
			};
		}

		const html = await resp.text();
		const parsed = await parseHtmlOffscreen(html, url);

		if (parsed?.textContent?.trim().length > 0) {
			return {
				ok: true,
				title: parsed.title || "",
				textContent: parsed.textContent.trim(),
				responseStatus: resp.status,
			};
		}

		return {
			ok: false,
			status: "malformed",
			responseStatus: resp.status,
			retryAfterSeconds: null,
			warnings: ["extraction_empty"],
		};
	} catch (err) {
		if (err.name === "AbortError") {
			console.warn(`[PDB] Fetch timeout for ${url}`);
		} else {
			console.error(`[PDB] fetchAndExtract error for ${url}:`, err);
		}
		return {
			ok: false,
			status: "inaccessible",
			responseStatus: null,
			retryAfterSeconds: null,
			warnings: [err.name === "AbortError" ? "fetch_timeout" : "fetch_error"],
		};
	}
}

async function hasOffscreenDocument() {
	if (chrome.runtime.getContexts) {
		const contexts = await chrome.runtime.getContexts({
			contextTypes: ["OFFSCREEN_DOCUMENT"],
			documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
		});
		return contexts.length > 0;
	}
	return chrome.offscreen.hasDocument();
}

async function ensureOffscreenDocument() {
	if (await hasOffscreenDocument()) return;
	if (!offscreenCreating) {
		offscreenCreating = chrome.offscreen
			.createDocument({
				url: OFFSCREEN_DOCUMENT_PATH,
				reasons: ["DOM_PARSER"],
				justification:
					"Parse fetched source HTML for reviewable change detection.",
			})
			.finally(() => {
				offscreenCreating = null;
			});
	}
	await offscreenCreating;
}

async function parseHtmlOffscreen(html, url) {
	await ensureOffscreenDocument();
	const result = await chrome.runtime.sendMessage({
		type: "parse-fetched-html",
		target: "offscreen-parser",
		html,
		url,
	});
	if (!result?.success) {
		throw new Error(result?.error || "Offscreen HTML extraction failed");
	}
	return result;
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

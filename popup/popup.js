const $ = (sel) => document.querySelector(sel);
const mainView = $("#main-view");
const settingsPanel = $("#settings-panel");
const bookmarkList = $("#bookmark-list");
const emptyState = $("#empty-state");
const trackBtn = $("#track-btn");
const toast = $("#toast");
const settingsBtn = $("#settings-btn");
const settingsBack = $("#settings-back");
const settingInterval = $("#setting-interval");
const settingNotifications = $("#setting-notifications");
const settingBadge = $("#setting-badge");

// ── Init ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
	await renderBookmarks();
	await loadSettings();
});

// ── Track page ─────────────────────────────────────────────────────

trackBtn.addEventListener("click", async () => {
	trackBtn.disabled = true;
	trackBtn.textContent = "Tracking...";

	try {
		const response = await chrome.runtime.sendMessage({
			type: "track-current-page",
		});

		if (response?.success) {
			showToast("Page tracked!");
			await renderBookmarks();
		} else {
			showToast(response?.error || "Failed to track page");
		}
	} catch (err) {
		console.error("[PDB Popup] track error:", err);
		showToast("Failed to track page");
	} finally {
		trackBtn.disabled = false;
		trackBtn.textContent = "+ Track";
	}
});

// ── Storage change listener ────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.pdb_bookmarks) {
		renderBookmarks();
	}
});

// ── Settings panel ─────────────────────────────────────────────────

settingsBtn.addEventListener("click", () => {
	mainView.style.display = "none";
	settingsPanel.classList.add("visible");
});

settingsBack.addEventListener("click", () => {
	settingsPanel.classList.remove("visible");
	mainView.style.display = "block";
});

settingInterval.addEventListener("change", () => {
	saveSettings();
});

settingNotifications.addEventListener("click", () => {
	settingNotifications.classList.toggle("on");
	saveSettings();
});

settingBadge.addEventListener("click", () => {
	settingBadge.classList.toggle("on");
	saveSettings();
});

async function loadSettings() {
	try {
		const { pdb_settings: settings } =
			await chrome.storage.local.get("pdb_settings");
		if (!settings) return;

		settingInterval.value = String(settings.defaultPollIntervalHours);
		settingNotifications.classList.toggle("on", settings.notificationsEnabled);
		settingBadge.classList.toggle("on", settings.badgeEnabled);
	} catch (err) {
		console.error("[PDB Popup] loadSettings error:", err);
	}
}

async function saveSettings() {
	try {
		await chrome.runtime.sendMessage({
			type: "update-settings",
			settings: {
				defaultPollIntervalHours: Number(settingInterval.value),
				notificationsEnabled: settingNotifications.classList.contains("on"),
				badgeEnabled: settingBadge.classList.contains("on"),
			},
		});
	} catch (err) {
		console.error("[PDB Popup] saveSettings error:", err);
	}
}

// ── Rendering ──────────────────────────────────────────────────────

async function renderBookmarks() {
	let bookmarks;
	try {
		bookmarks = await chrome.runtime.sendMessage({ type: "get-bookmarks" });
	} catch (err) {
		console.error("[PDB Popup] get-bookmarks error:", err);
		bookmarks = [];
	}

	if (!bookmarks || bookmarks.length === 0) {
		emptyState.style.display = "flex";
		bookmarkList.style.display = "none";
		bookmarkList.innerHTML = "";
		return;
	}

	emptyState.style.display = "none";
	bookmarkList.style.display = "block";

	const sorted = [...bookmarks].sort((a, b) => b.addedAt - a.addedAt);

	bookmarkList.innerHTML = sorted
		.map((bm) => {
			const unreadClass = bm.hasUnreadDiff ? " unread" : "";
			const pausedClass = bm.paused ? " paused" : "";
			const intervalOptions = [1, 3, 6, 12, 24]
				.map(
					(h) =>
						`<option value="${h}"${h === bm.pollIntervalHours ? " selected" : ""}>${h}h</option>`,
				)
				.join("");

			return `
      <li class="bookmark-item${unreadClass}${pausedClass}" data-id="${bm.id}">
        <div class="bookmark-row">
          <img class="bookmark-favicon" src="${escapeAttr(bm.favicon)}" alt=""
               onerror="this.style.display='none'" />
          <div class="bookmark-info">
            <div class="bookmark-title" title="${escapeAttr(bm.title)}">${escapeHtml(bm.title)}</div>
            <div class="bookmark-url" title="${escapeAttr(bm.url)}">${escapeHtml(truncateUrl(bm.url, 42))}</div>
            <div class="bookmark-meta">${formatMeta(bm)}</div>
          </div>
        </div>
        <div class="bookmark-controls">
          <button class="btn btn-sm" data-pause="${bm.id}" title="${bm.paused ? "Resume polling" : "Pause polling"}">
            ${bm.paused ? "&#9654;" : "&#9208;"}
          </button>
          <select class="interval-select" data-interval="${bm.id}">${intervalOptions}</select>
          <button class="btn btn-sm" data-check="${bm.id}">&#8635; Check</button>
          <button class="btn btn-sm btn-diff" data-viewdiff="${bm.id}" ${bm.hasUnreadDiff ? "" : "disabled"}>
            View Diff
          </button>
          <button class="btn-icon delete" data-delete="${bm.id}" title="Remove">&#x2715;</button>
        </div>
      </li>`;
		})
		.join("");

	attachHandlers();
}

function attachHandlers() {
	// Delete
	bookmarkList.querySelectorAll("[data-delete]").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			try {
				await chrome.runtime.sendMessage({
					type: "delete-bookmark",
					bookmarkId: btn.dataset.delete,
				});
				showToast("Bookmark removed");
			} catch (err) {
				console.error("[PDB Popup] delete error:", err);
				showToast("Failed to remove");
			}
		});
	});

	// Pause/Resume
	bookmarkList.querySelectorAll("[data-pause]").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const id = btn.dataset.pause;
			const isPaused = btn
				.closest(".bookmark-item")
				.classList.contains("paused");
			try {
				await chrome.runtime.sendMessage({
					type: isPaused ? "resume-bookmark" : "pause-bookmark",
					bookmarkId: id,
				});
			} catch (err) {
				console.error("[PDB Popup] pause/resume error:", err);
			}
		});
	});

	// Interval change
	bookmarkList.querySelectorAll("[data-interval]").forEach((sel) => {
		sel.addEventListener("change", async (e) => {
			e.stopPropagation();
			try {
				await chrome.runtime.sendMessage({
					type: "set-poll-interval",
					bookmarkId: sel.dataset.interval,
					hours: Number(sel.value),
				});
			} catch (err) {
				console.error("[PDB Popup] set-interval error:", err);
			}
		});
	});

	// Check Now
	bookmarkList.querySelectorAll("[data-check]").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			btn.disabled = true;
			btn.textContent = "...";
			try {
				await chrome.runtime.sendMessage({
					type: "check-now",
					bookmarkId: btn.dataset.check,
				});
				showToast("Check complete");
			} catch (err) {
				console.error("[PDB Popup] check-now error:", err);
			} finally {
				btn.disabled = false;
				btn.innerHTML = "&#8635; Check";
			}
		});
	});

	// View Diff
	bookmarkList.querySelectorAll("[data-viewdiff]").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const id = btn.dataset.viewdiff;
			try {
				// Mark as read + set active diff ID
				await chrome.runtime.sendMessage({
					type: "mark-diff-read",
					bookmarkId: id,
				});
				await chrome.storage.local.set({ pdb_active_diff_id: id });

				// Open side panel — this IS from a user gesture, so it works
				// sidePanel.open requires tabId, not windowId
				const [tab] = await chrome.tabs.query({
					active: true,
					lastFocusedWindow: true,
				});
				if (tab?.id) {
					await chrome.sidePanel.open({ tabId: tab.id });
				}
			} catch (err) {
				console.error("[PDB Popup] view-diff error:", err);
			}
		});
	});
}

// ── Helpers ─────────────────────────────────────────────────────────

function truncateUrl(url, maxLen) {
	try {
		const u = new URL(url);
		const display = u.hostname + u.pathname;
		return display.length > maxLen ? display.slice(0, maxLen) + "..." : display;
	} catch {
		return url.length > maxLen ? url.slice(0, maxLen) + "..." : url;
	}
}

function formatMeta(bm) {
	const parts = [];
	if (bm.paused) {
		parts.push("Paused");
	} else if (bm.lastChecked) {
		parts.push(formatRelativeTime(bm.lastChecked, "Checked"));
	} else {
		parts.push("Never checked");
	}
	if (bm.changeCount > 0) {
		parts.push(`${bm.changeCount} change${bm.changeCount > 1 ? "s" : ""}`);
	}
	return parts.join(" &middot; ");
}

function formatRelativeTime(timestamp, prefix) {
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return `${prefix} just now`;
	if (mins < 60) return `${prefix} ${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${prefix} ${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${prefix} ${days}d ago`;
}

function escapeHtml(str) {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

function escapeAttr(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

let toastTimer;
function showToast(msg) {
	toast.textContent = msg;
	toast.classList.add("visible");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove("visible"), 2000);
}

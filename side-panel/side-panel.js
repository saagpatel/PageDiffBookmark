const diffView = document.getElementById("diff-view");
const emptyState = document.getElementById("empty-state");
const diffTitle = document.getElementById("diff-title");
const diffBody = document.getElementById("diff-body");
const statAdded = document.getElementById("stat-added");
const statRemoved = document.getElementById("stat-removed");
const diffTime = document.getElementById("diff-time");
const markReadBtn = document.getElementById("mark-read-btn");

let currentBookmarkId = null;

// ── Init ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
	await loadActiveDiff();
});

// Auto-refresh when a new diff ID is set (e.g. from notification click)
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.pdb_active_diff_id) {
		loadActiveDiff();
	}
});

markReadBtn.addEventListener("click", async () => {
	if (!currentBookmarkId) return;
	try {
		await chrome.runtime.sendMessage({
			type: "mark-diff-read",
			bookmarkId: currentBookmarkId,
		});
		markReadBtn.textContent = "Marked as read";
		markReadBtn.disabled = true;
	} catch (err) {
		console.error("[PDB Side Panel] mark-diff-read error:", err);
	}
});

// ── Load & Render ──────────────────────────────────────────────────

async function loadActiveDiff() {
	try {
		const { pdb_active_diff_id: bookmarkId } =
			await chrome.storage.local.get("pdb_active_diff_id");

		if (!bookmarkId) {
			showEmpty();
			return;
		}

		currentBookmarkId = bookmarkId;

		// Load diff and bookmark data in parallel
		const [diffResult, bookmarks] = await Promise.all([
			chrome.runtime.sendMessage({ type: "get-diff", bookmarkId }),
			chrome.runtime.sendMessage({ type: "get-bookmarks" }),
		]);

		if (!diffResult) {
			showEmpty();
			return;
		}

		const bookmark = bookmarks?.find((b) => b.id === bookmarkId);
		renderDiff(diffResult, bookmark);
	} catch (err) {
		console.error("[PDB Side Panel] loadActiveDiff error:", err);
		showEmpty();
	}
}

function renderDiff(diff, bookmark) {
	emptyState.style.display = "none";
	diffView.style.display = "block";

	// Title with link
	const title = bookmark?.title || "Unknown Page";
	const url = bookmark?.url || "";
	if (url) {
		diffTitle.innerHTML = `<a href="${escapeAttr(url)}" target="_blank">${escapeHtml(title)}</a>`;
	} else {
		diffTitle.textContent = title;
	}

	// Stats
	statAdded.textContent = `+${diff.addedSentences} added`;
	statRemoved.textContent = `-${diff.removedSentences} removed`;
	diffTime.textContent = formatRelativeTime(diff.detectedAt);

	// Diff body — htmlDiff is pre-rendered with <ins>/<del> tags
	diffBody.innerHTML = diff.htmlDiff;

	// Mark as read button state
	if (bookmark?.hasUnreadDiff) {
		markReadBtn.textContent = "Mark as read";
		markReadBtn.disabled = false;
	} else {
		markReadBtn.textContent = "Already read";
		markReadBtn.disabled = true;
	}
}

function showEmpty() {
	diffView.style.display = "none";
	emptyState.style.display = "flex";
	currentBookmarkId = null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatRelativeTime(timestamp) {
	if (!timestamp) return "";
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
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

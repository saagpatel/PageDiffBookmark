const $ = (sel) => document.querySelector(sel);
const bookmarkList = $("#bookmark-list");
const emptyState = $("#empty-state");
const trackBtn = $("#track-btn");
const toast = $("#toast");

// ── Init ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
	await renderBookmarks();
});

trackBtn.addEventListener("click", async () => {
	trackBtn.disabled = true;
	trackBtn.textContent = "Tracking...";

	const response = await chrome.runtime.sendMessage({
		type: "track-current-page",
	});

	trackBtn.disabled = false;
	trackBtn.textContent = "+ Track Page";

	if (response?.success) {
		showToast("Page tracked!");
		await renderBookmarks();
	} else {
		showToast(response?.error || "Failed to track page");
	}
});

// Listen for storage changes to update in real-time
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.pdb_bookmarks) {
		renderBookmarks();
	}
});

// ── Rendering ──────────────────────────────────────────────────────

async function renderBookmarks() {
	const bookmarks = await chrome.runtime.sendMessage({ type: "get-bookmarks" });

	if (!bookmarks || bookmarks.length === 0) {
		emptyState.style.display = "flex";
		bookmarkList.style.display = "none";
		bookmarkList.innerHTML = "";
		return;
	}

	emptyState.style.display = "none";
	bookmarkList.style.display = "block";

	// Sort by most recently added
	const sorted = [...bookmarks].sort((a, b) => b.addedAt - a.addedAt);

	bookmarkList.innerHTML = sorted
		.map(
			(bm) => `
    <li class="bookmark-item" data-id="${bm.id}">
      <img
        class="bookmark-favicon"
        src="${escapeAttr(bm.favicon)}"
        alt=""
        onerror="this.style.display='none'"
      />
      <div class="bookmark-info">
        <div class="bookmark-title" title="${escapeAttr(bm.title)}">${escapeHtml(bm.title)}</div>
        <div class="bookmark-url" title="${escapeAttr(bm.url)}">${escapeHtml(truncateUrl(bm.url, 45))}</div>
        <div class="bookmark-meta">${formatLastChecked(bm.lastChecked)}</div>
      </div>
      <div class="bookmark-actions">
        <button class="btn-icon delete" data-delete="${bm.id}" title="Remove">&#x2715;</button>
      </div>
    </li>
  `,
		)
		.join("");

	// Attach delete handlers
	bookmarkList.querySelectorAll("[data-delete]").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const id = btn.dataset.delete;
			await chrome.runtime.sendMessage({
				type: "delete-bookmark",
				bookmarkId: id,
			});
			showToast("Bookmark removed");
			await renderBookmarks();
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

function formatLastChecked(timestamp) {
	if (!timestamp) return "Never checked";
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "Checked just now";
	if (mins < 60) return `Checked ${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `Checked ${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `Checked ${days}d ago`;
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

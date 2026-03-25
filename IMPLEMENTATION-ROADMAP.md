# Page DiffBookmark — Implementation Roadmap

## Architecture

### System Overview

```
[Toolbar Button / Context Menu]
         |
         ▼
[content-script.js]  ←──── Injected into active tab
   Extracts text via Readability.js
   Sends extracted text → background
         |
         ▼
[service-worker.js]  ←──── MV3 background service worker
   Receives snapshot
   Writes to chrome.storage.local
   Manages chrome.alarms (poll intervals)
         |
    ┌────┴────┐
    ▼         ▼
[chrome.alarms]    [chrome.storage.local]
   Fires every N hours    Stores: bookmarks[], snapshots{}
         |
         ▼
[Poll cycle: service-worker.js]
   fetch(url) → inject Readability → diff vs. stored snapshot
   If changed → chrome.notifications.create()
              → update badge count
              → write diff result to storage
         |
         ▼
[popup.html / popup.js]    [side-panel.html / side-panel.js]
   Bookmark list            Inline diff view with sentence-level
   Badge count              highlights (green=added, red=removed)
   Open diff view           Triggered from notification click
```

### File Structure

```
page-diffbookmark/
├── manifest.json                    # MV3 manifest
├── background/
│   └── service-worker.js            # Polling engine, diff orchestration, alarm management
├── content/
│   └── content-script.js            # Readability extraction, message relay to background
├── popup/
│   ├── popup.html                   # Bookmark list UI
│   └── popup.js                     # Bookmark CRUD, open side panel, show badge state
├── side-panel/
│   ├── side-panel.html              # Diff viewer UI
│   └── side-panel.js                # Renders sentence-level diff with color highlights
├── lib/
│   ├── diff-match-patch.js          # Google diff library (bundled, v1.0.5)
│   └── Readability.js               # Mozilla Readability (bundled, v0.5.0)
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── CLAUDE.md
```

### Data Model (chrome.storage.local keys)

**`pdb_bookmarks`** — Array of bookmark objects
```typescript
interface Bookmark {
  id: string;              // UUID v4, e.g. "a1b2c3d4-..."
  url: string;             // Full URL
  title: string;           // Page title at time of bookmarking
  favicon: string;         // Data URL or empty string
  addedAt: number;         // Unix timestamp (ms)
  lastChecked: number;     // Unix timestamp (ms), 0 if never checked
  lastChanged: number;     // Unix timestamp (ms), 0 if never changed
  pollIntervalHours: number; // Default: 6. Options: 1, 3, 6, 12, 24
  paused: boolean;         // If true, skip in poll cycle
  hasUnreadDiff: boolean;  // True after change detected, cleared when diff viewed
  changeCount: number;     // Total change detections since adding
}
```

**`pdb_snapshot_{id}`** — One key per bookmark, stores extracted text snapshot
```typescript
interface Snapshot {
  bookmarkId: string;
  extractedText: string;   // Readability output — plain text, no HTML
  capturedAt: number;      // Unix timestamp (ms)
  sentenceCount: number;   // For UI display
}
```

**`pdb_diff_{id}`** — Most recent diff result for a bookmark
```typescript
interface DiffResult {
  bookmarkId: string;
  detectedAt: number;        // Unix timestamp (ms)
  addedSentences: number;        // Count of added sentences
  removedSentences: number;      // Count of removed sentences
  htmlDiff: string;          // Pre-rendered HTML with <ins>/<del> tags for side panel
  previousSentenceCount: number;
  currentSentenceCount: number;
}
```

**`pdb_settings`** — Global settings
```typescript
interface Settings {
  defaultPollIntervalHours: number;  // Default: 6
  notificationsEnabled: boolean;     // Default: true
  badgeEnabled: boolean;             // Default: true
  maxBookmarks: number;              // Default: 100 (storage cap protection)
}
```

### Storage Budget

| Data | Per bookmark | 100 bookmarks |
|------|-------------|---------------|
| Bookmark metadata | ~0.5KB | ~50KB |
| Snapshot (extracted text) | ~5–20KB | ~2MB |
| Diff result (HTML) | ~5–30KB | ~3MB |
| **Total** | | **~5MB** (well under 10MB local limit) |

### Dependencies (no npm — manual bundling)

```bash
# Download and place in /lib/
# diff-match-patch v1.0.5
curl -o lib/diff-match-patch.js \
  https://raw.githubusercontent.com/google/diff-match-patch/master/javascript/diff_match_patch_uncompressed.js

# Mozilla Readability v0.5.0
curl -o lib/Readability.js \
  https://raw.githubusercontent.com/mozilla/readability/main/Readability.js
```

### Key Chrome APIs Used

| API | Purpose | Permission Required |
|-----|---------|-------------------|
| `chrome.storage.local` | All persistence | `storage` |
| `chrome.alarms` | Poll scheduling | `alarms` |
| `chrome.notifications` | OS-level change alerts | `notifications` |
| `chrome.action.setBadgeText` | Unread diff count badge | — (action permission) |
| `chrome.tabs.executeScript` | Inject content script on demand | `activeTab` |
| `chrome.sidePanel` | Diff viewer panel | `sidePanel` |
| `chrome.contextMenus` | Right-click "Track this page" | `contextMenus` |

### manifest.json (complete)

```json
{
  "manifest_version": 3,
  "name": "Page DiffBookmark",
  "version": "1.0.0",
  "description": "Bookmark pages and get notified when content changes.",
  "permissions": [
    "storage",
    "alarms",
    "notifications",
    "contextMenus",
    "sidePanel",
    "activeTab",
    "scripting"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "side_panel": {
    "default_path": "side-panel/side-panel.html"
  },
  "content_scripts": [],
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

Note: Content script is injected programmatically via `chrome.scripting.executeScript`, not declared statically, so we can inject Readability.js alongside it.

---

## Scope Boundaries

**In scope:**
- Bookmark current tab via toolbar button or right-click context menu
- Background polling via `chrome.alarms` at per-bookmark configurable intervals (1/3/6/12/24h)
- Text extraction via Readability.js before diffing (strips chrome, ads, nav)
- Word-level diff via diff-match-patch
- OS notification on change detection with deep-link to diff view
- Badge count showing total unread diffs
- Side panel with inline diff view (green = added sentences, red = removed sentences)
- Popup: bookmark list with last-checked/last-changed timestamps, pause/resume, delete, open diff
- Per-bookmark: pause/resume, custom poll interval
- Global settings: default interval, notification toggle, badge toggle

**Out of scope (v1):**
- Cloud sync or remote backup
- Auth / accounts
- Email or Slack alerts
- Screenshot/visual diffing (DOM text only)
- Firefox / Safari support
- Diff history beyond most recent change
- CSS selector scoping (diff whole page only)
- Import/export of bookmarks

**Deferred to v2:**
- Full diff history (last N snapshots)
- Regex/selector scoping per bookmark ("only watch the price element")
- Export bookmarks as JSON
- Bulk operations (pause all, check all now)

---

## Security & Privacy

- **No external network calls** except `fetch(bookmarked_url)` for polling — zero third-party servers
- All data stored in `chrome.storage.local` — never leaves the machine
- Content script runs in page context to extract text; extracted text (not raw HTML) is the only thing sent to background
- No credentials stored anywhere
- `fetch()` in service worker uses same-origin headers as a normal browser request; does not bypass auth walls (this is expected/acceptable behavior)
- Sensitive page content (extracted text) never logged to console in production builds

---

## Phase 0: Foundation (Days 1–2)

### Objectives
- Project scaffolded and loadable as an unpacked extension in Chrome
- Toolbar button renders a placeholder popup
- Right-click context menu item exists ("Track this page")
- Lib files downloaded and bundled
- Storage schema initialized on first run
- Basic bookmark add/list/delete working end-to-end (no polling yet)

### Tasks

1. **Create project skeleton** — all files and directories from File Structure section above, with empty/stub content.
   - **Acceptance:** Load `page-diffbookmark/` as unpacked extension in `chrome://extensions` → no errors in service worker console.

2. **Download lib dependencies** into `/lib/` — `diff-match-patch.js` and `Readability.js`.
   - **Acceptance:** Both files exist and are non-zero size. `typeof DiffMatchPatch !== 'undefined'` when imported in a test page.

3. **Implement `pdb_settings` initialization** in `service-worker.js` — on `chrome.runtime.onInstalled`, write default settings to storage if key doesn't exist.
   - **Acceptance:** Install extension, open chrome DevTools > Application > Extension Storage > `pdb_settings` shows `{"defaultPollIntervalHours":6,"notificationsEnabled":true,"badgeEnabled":true,"maxBookmarks":100}`.

4. **Implement `chrome.contextMenus` setup** in `service-worker.js` — create "Track this page" item on `onInstalled`.
   - **Acceptance:** Right-click any page → context menu shows "Track this page".

5. **Implement content script injection + Readability extraction** — when toolbar button clicked OR context menu item clicked, `chrome.scripting.executeScript` injects `Readability.js` + `content-script.js` into the active tab. Content script runs Readability on `document.cloneNode(true)`, returns `{title, textContent, url}` to background via `sendResponse`.
   - **Acceptance:** Click toolbar button on `news.ycombinator.com` → service worker console logs extracted title and first 200 chars of textContent.

6. **Implement bookmark add + storage write** — background receives extracted content, creates a `Bookmark` object (generate UUID via `crypto.randomUUID()`), writes to `pdb_bookmarks` array and creates `pdb_snapshot_{id}` key.
   - **Acceptance:** Bookmark a page, inspect storage → `pdb_bookmarks` array has 1 entry, `pdb_snapshot_{id}` key exists with `extractedText` populated.

7. **Build popup UI** — `popup.html` shows list of bookmarks from storage (title, URL truncated to 40 chars, last-checked timestamp as "Never" or relative time). Buttons: Delete per row. Empty state: "No pages tracked yet. Click the icon on any page to start."
   - **Acceptance:** After bookmarking 3 pages, open popup → all 3 shown with title and URL. Delete one → list updates immediately.

### Phase 0 Verification Checklist
- [ ] Load extension → no console errors in service worker
- [ ] Right-click any page → "Track this page" appears in context menu
- [ ] Click toolbar button on HN, Wikipedia, and a news article → popup shows all 3 bookmarks
- [ ] Delete a bookmark from popup → entry removed, storage key `pdb_snapshot_{id}` also deleted
- [ ] Inspect `chrome.storage.local` → `pdb_bookmarks` schema matches TypeScript interface exactly

### Risks & Mitigations
- **Risk:** Readability.js fails on SPAs / React-rendered pages (content not in initial DOM)
  - **Mitigation:** Add a 500ms delay before Readability runs in the content script; retry once on empty result
  - **Fallback:** If Readability returns empty, fall back to `document.body.innerText` (noisier but always works)
- **Risk:** `chrome.scripting.executeScript` blocked on `chrome://` or `chrome-extension://` pages
  - **Mitigation:** Wrap in try/catch, show toast in popup "This page can't be tracked"

---

## Phase 1: Polling Engine (Days 3–4)

### Objectives
- Background service worker polls all active (non-paused) bookmarks on their configured intervals
- Change detection runs diff; stores result when changed
- OS notification fires on change with correct deep-link
- Badge count reflects unread diff count

### Tasks

1. **Implement `chrome.alarms` polling loop** — on install and on adding a bookmark, register a `chrome.alarms.create('poll-{id}', {periodInMinutes: N})` per bookmark. On `chrome.alarms.onAlarm`, route to poll handler.
   - **Acceptance:** Add a bookmark with 1h interval. Inspect `chrome.alarms.getAll()` → alarm exists with correct period. Wait 1 minute (set interval to 1min in dev), confirm `lastChecked` timestamp updates in storage.

2. **Implement poll handler in `service-worker.js`** — fetches URL, injects Readability programmatically (using `chrome.scripting.executeScript` on a hidden offscreen document OR via a regular fetch + DOM parser approach). Extract text, compare vs. stored snapshot via diff-match-patch.
   - **Acceptance:** Manually trigger poll by temporarily setting alarm to 1 minute. Console logs: "No change detected" or "Change detected: +3 sentences, -1 sentence".
   - **Note:** For background fetch without a visible tab, use `fetch()` + `DOMParser` + Readability to avoid needing an active tab. See implementation note below.

3. **Implement diff logic** — sentence-level diff using diff-match-patch. Split extracted text into sentences (split on `.`, `!`, `?` + whitespace), diff the sentence arrays, convert to HTML with `<ins>sentence</ins>` for additions (green) and `<del>sentence</del>` for removals (red). Store as `pdb_diff_{id}`.
   - **Acceptance:** Manually edit a bookmark's stored snapshot to differ from current page. Trigger poll. Inspect `pdb_diff_{id}` → `htmlDiff` field contains `<ins>` and `<del>` tags matching expected changes.

4. **Implement OS notifications** — `chrome.notifications.create` with title "Page changed: {bookmark title}", message "{+N sentences added, -N sentences removed}", icon from bookmark favicon. Store `notificationId → bookmarkId` mapping for click handling.
   - **Acceptance:** Trigger a detected change → OS notification appears with correct title and sentence counts.

5. **Implement notification click handler** — `chrome.notifications.onClicked` → open side panel for the affected bookmark's diff.
   - **Acceptance:** Click notification → side panel opens showing that bookmark's diff.

6. **Implement badge count** — after each poll cycle, count `bookmarks.filter(b => b.hasUnreadDiff).length`. Call `chrome.action.setBadgeText({text: N > 0 ? String(N) : ''})` and `chrome.action.setBadgeBackgroundColor({color: '#E53E3E'})`.
   - **Acceptance:** Trigger 2 change detections → badge shows "2" in red. Open both diffs (marking as read) → badge clears.

### Implementation Note: Background fetch + Readability without active tab

```javascript
// In service-worker.js — fetch page and extract text without injecting into user's tab
async function fetchAndExtract(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': navigator.userAgent }
  });
  const html = await resp.text();
  // Use DOMParser in service worker context (available in MV3 service workers)
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const reader = new Readability(doc);
  const article = reader.parse();
  return article ? article.textContent : doc.body.innerText;
}
```

### Phase 1 Verification Checklist
- [ ] `chrome.alarms.getAll()` shows one alarm per non-paused bookmark
- [ ] After poll cycle with no changes: `lastChecked` updates, `hasUnreadDiff` stays false
- [ ] After manufactured change: OS notification fires within poll window
- [ ] Badge count matches `bookmarks.filter(b => b.hasUnreadDiff).length` exactly
- [ ] Clicking notification opens side panel (even if side panel was closed)

### Risks & Mitigations
- **Risk:** `DOMParser` + `Readability` in MV3 service worker may fail (Readability uses `window` globals)
  - **Mitigation:** Import Readability with patched globals (`global.window = self`) at top of service worker
  - **Fallback:** Use regex-strip approach (`html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')`) — noisier but always works
- **Risk:** Fetched page requires auth (returns login page instead of content) — diff always fires
  - **Mitigation:** Compare sentence count: if new snapshot is <20% of original snapshot sentence count, flag as "may be auth wall" and skip notification

---

## Phase 2: Diff Viewer + Full Popup (Days 5–7)

### Objectives
- Side panel renders beautiful sentence-level diff with full context
- Popup is fully functional: filter, pause/resume, per-bookmark settings
- All three notification surfaces working together
- Extension is daily-use ready

### Tasks

1. **Build side panel diff viewer** — `side-panel.html` receives `bookmarkId` via URL param or `chrome.runtime.sendMessage`. Loads `pdb_diff_{id}` from storage. Renders: page title (linked), detected-at timestamp, sentence counts (+N / -N), full diff HTML with CSS for `ins` (green highlight) and `del` (red strikethrough+highlight). "Mark as read" button clears `hasUnreadDiff`.
   - **Acceptance:** Trigger a change, click notification, side panel opens → diff visible with correct colors, sentence counts, timestamp. Click "Mark as read" → `hasUnreadDiff` set to false, badge count decrements.

2. **Add per-bookmark controls to popup** — each bookmark row gets: pause/resume toggle, poll interval selector (1h/3h/6h/12h/24h), "Check Now" button (manually triggers poll), "View Diff" button (disabled if no unread diff). Badge on rows with unread diff.
   - **Acceptance:** Click "Check Now" on a bookmark → `lastChecked` updates within 5 seconds. Pause a bookmark → its alarm is removed from `chrome.alarms`. Change interval to 1h → alarm re-registered with new period.

3. **Implement settings panel in popup** — gear icon opens inline settings: default poll interval, notifications on/off, badge on/off. Writes to `pdb_settings`. Changes apply immediately (re-register alarms if default interval changes for bookmarks using the default).
   - **Acceptance:** Toggle notifications off → next change detection does NOT fire OS notification but DOES update badge and `hasUnreadDiff`.

4. **Polish + edge cases:**
   - Empty popup state with "Start tracking" CTA
   - Popup shows "Checking..." spinner on active polls
   - Truncate diff HTML to 50KB max (very long pages) with "Content truncated — view full diff by re-checking" note
   - Handle deleted/moved pages (fetch returns 404/301) — show status badge "Page unavailable" in popup row, skip diff
   - Deduplicate bookmark URLs (same URL added twice → reject with toast "Already tracking this page")
   - **Acceptance:** Bookmark the same URL twice → toast appears, no duplicate in list. Simulate 404 by bookmarking a URL then making it 404 → popup shows "Page unavailable" badge.

5. **Final icon set** — create simple 16/48/128 PNG icons (dark circle with "Δ" diff symbol or bookmark shape). Can use a Canvas snippet to generate programmatically.
   - **Acceptance:** Extension icon visible in Chrome toolbar at correct sizes, no blurry/pixelated rendering.

### Phase 2 Verification Checklist
- [ ] Full E2E test: bookmark a page → wait for poll → change detected → OS notification fires → click notification → side panel shows diff → mark as read → badge clears
- [ ] Pause a bookmark → verify alarm removed → no further notifications for that bookmark
- [ ] Settings: disable badge → badge never appears even when changes detected
- [ ] Duplicate URL rejection works
- [ ] 404 page handling: bookmark shows "Page unavailable", no false-positive diff notification
- [ ] Popup renders correctly for 0, 1, 5, and 20+ bookmarks (scroll behavior)

### Risks & Mitigations
- **Risk:** Side panel API (`chrome.sidePanel`) may have cross-tab state issues with `bookmarkId` passing
  - **Mitigation:** Pass `bookmarkId` via `chrome.storage.local` key `pdb_active_diff_id` rather than URL param — more reliable across panel open/close cycles
- **Risk:** Very long page diffs (100KB+) cause side panel to freeze
  - **Mitigation:** Truncate `htmlDiff` at storage time to 50KB. Add pagination ("Show more") if needed in v2.

---

## Testing Strategy

### Manual test matrix (run before each phase sign-off)

| Scenario | Expected |
|----------|----------|
| Bookmark HN front page | Title correct, snapshot stored, popup shows entry |
| Bookmark a paywalled article | Snapshot captures whatever text is visible |
| Wait for poll (set to 1min in dev) | `lastChecked` updates, no false positive |
| Manually edit snapshot in DevTools, trigger poll | Change detected, notification fires |
| Click notification | Side panel opens with diff |
| Mark as read | Badge decrements |
| Pause bookmark | No more alarms, no notifications |
| Delete bookmark | Entry removed from storage, snapshot key deleted, alarm removed |
| Add duplicate URL | Toast rejection, no duplicate |
| 404 URL | "Page unavailable" in popup, no notification |
| 50+ bookmarks | Popup scrollable, poll queue doesn't jam |

### Dev shortcuts to enable during development (disable before shipping)
- `DEV_POLL_INTERVAL_MINUTES = 1` constant at top of `service-worker.js`
- `window.pdebug = { triggerPoll(id), clearAllStorage(), listBookmarks() }` exposed in service worker for DevTools console testing

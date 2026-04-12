# Page DiffBookmark

A privacy-first Chrome Extension (MV3) that lets users bookmark any web page and get notified when its content changes. Background polling snapshots page text, diffs it at the word level, and surfaces changes via OS notifications, popup badge count, and an inline side panel diff view. No external servers — all data stays local.

## Tech Stack
- **Runtime**: Chrome Extension Manifest V3
- **Language**: Vanilla JS (ES2022) — no build step, no framework
- **Diffing**: `diff-match-patch` v1.0.5 (Google) — bundled in `/lib/`
- **Content extraction**: `@mozilla/readability` v0.5.0 — bundled in `/lib/`
- **Storage**: `chrome.storage.local` — all data local, no sync
- **Scheduling**: `chrome.alarms` API — MV3-compliant polling

## Status
Phase 2 complete — all planned phases shipped:
- Phase 0: Extension scaffold, bookmark CRUD, content extraction (with service worker and error handling fixes)
- Phase 1: Polling engine with background fetch, diff computation, and OS notifications
- Phase 2: Diff viewer UI, per-bookmark polling controls, settings panel

## Build & Run
No build step required. Load unpacked in Chrome:
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" and select the project root directory

## Architecture
- `manifest.json` — MV3 manifest with service worker, alarms, notifications permissions
- `background/` — service worker: polling scheduler, diff computation, notification dispatch
- `content/` — content script: page text extraction via Readability before sending to background
- `popup/` — bookmark management UI, change badge display
- `side-panel/` — inline diff viewer with word-level change highlighting
- `lib/` — bundled diff-match-patch and readability (no npm, no build step)
- All fetching done in the service worker — content scripts never make fetch requests
- Storage: previous snapshot only (1 deep) to keep storage under ~10MB for typical 50-page sets

## Known Issues
- Service worker may be terminated by Chrome between polling intervals on some systems; alarms re-wake it correctly
- Readability extraction may strip meaningful content on single-page apps with dynamic rendering

# PageDiffBookmark

[![JavaScript](https://img.shields.io/badge/JavaScript-f7df1e?style=flat-square&logo=javascript&logoColor=black)](#) [![Status](https://img.shields.io/badge/status-WIP-yellow?style=flat-square)](#)

> Chrome extension that bookmarks web pages and notifies you when their content changes.

PageDiffBookmark tracks pages you care about, polls them in the background, and surfaces a sentence-level diff in a browser-native side panel when something changes.

## Features

- **Track any page** — Via popup button or right-click context menu
- **Background polling** — Configurable per-bookmark interval (1h, 3h, 6h, 12h, or 24h)
- **Sentence-level diff** — Powered by diff-match-patch and Mozilla Readability; shows `<ins>`/`<del>` inline
- **OS notifications** — Added/removed sentence counts when a change is detected
- **Auth wall detection** — Skips snapshots where content drops below 20% of baseline
- **Badge counter** — Unread change count on the extension icon
- **No build step** — Plain JavaScript, load unpacked directly

## Quick Start

1. Clone or download this repository
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** and select the `PageDiffBookmark` directory
4. Navigate to any page and click **+ Track** in the popup

## Tech Stack

| Layer | Technology |
|-------|------------|
| Extension platform | Chrome Manifest V3 |
| Background | Service Worker |
| Content extraction | Mozilla Readability.js |
| Diff engine | Google diff-match-patch |
| Storage | `chrome.storage.local` |
| UI | Vanilla HTML/CSS/JS |

> **Status: Work in Progress** — Core tracking, diffing, and side panel functional. Cross-browser support not yet implemented.

## Known Issues

- Service worker may be terminated by Chrome between polling intervals on some systems; alarms re-wake it correctly
- Readability extraction may strip meaningful content on single-page apps with dynamic rendering
- Automatic polling is deliberately unarmed by default; manual `check-now` is the qualified path until separate scheduling authority and recurrence proof exist

## Living Research upgrade

PageDiffBookmark now emits a portable, data-first `ResearchCapturePacketV1`
for the KBFreshnessDetector manual research ledger. Packets retain stable source
identity, content identity, capture provenance, warnings, and diff counts.
Scheduling is unarmed by default (`automationArmed: false` and no development
poll override); manual `check-now` remains available. See
[`docs/LIVING_RESEARCH_ADAPTER.md`](docs/LIVING_RESEARCH_ADAPTER.md).
The adapter records baselines, unchanged observations, material diffs, and
failure states, while retaining only the latest 100 packets per source.

## License

MIT

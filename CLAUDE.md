# Page DiffBookmark

## Overview
A privacy-first Chrome Extension (MV3) that lets users bookmark any web page and get notified when its content changes. Background polling snapshots page text, diffs it at the word level, and surfaces changes via OS notifications, popup badge count, and an inline side panel diff view. No external servers. All data stays local.

## Tech Stack
- Runtime: Chrome Extension Manifest V3
- Language: Vanilla JS (ES2022) — no build step, no framework
- Diffing: `diff-match-patch` v1.0.5 (Google) — bundled in `/lib/`
- Content extraction: `@mozilla/readability` v0.5.0 — bundled in `/lib/`
- Storage: `chrome.storage.local` — all data local, no sync
- Scheduling: `chrome.alarms` API — MV3-compliant polling

## Project Structure
See IMPLEMENTATION-ROADMAP.md for full file layout.

## Current Phase
**Phase 0: Foundation**
See IMPLEMENTATION-ROADMAP.md for full phase details.

## Key Decisions
| Decision | Choice | Why |
|----------|--------|-----|
| Manifest version | MV3 | Required going forward; service worker = background polling |
| No build step | Vanilla JS | Faster iteration, no Webpack/Vite to configure |
| Content extraction | Readability.js before diffing | Strips nav/ads/boilerplate — reduces false positives dramatically |
| Diff algorithm | diff-match-patch sentence-level | Less noisy than word-level; better for articles and job postings |
| Diff storage | Previous snapshot only (1 deep) | Keeps storage < 10MB for typical 50-page bookmark set |
| Notification surface | All three (OS + badge + side panel) | User selected this during planning |

## Do NOT
- Do not use `localStorage` or `sessionStorage` — use `chrome.storage.local` exclusively
- Do not make fetch requests from content scripts — all fetching is done in the service worker
- Do not add features not in the current phase of IMPLEMENTATION-ROADMAP.md
- Do not bundle React or any UI framework — vanilla DOM only
- Do not store raw full HTML snapshots — extract text via Readability before storing (reduces per-page storage by ~90%)
- Do not skip the Readability extraction step before diffing — raw HTML diffs are too noisy to be useful

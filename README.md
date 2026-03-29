# Page DiffBookmark

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](manifest.json)
[![Manifest](https://img.shields.io/badge/manifest-v3-brightgreen.svg)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

A Chrome extension that bookmarks web pages and notifies you when their content changes. It periodically polls tracked pages in the background, computes a sentence-level diff when changes are detected, and surfaces results in a browser-native side panel.

## Screenshot

> _Screenshot placeholder — add a screenshot of the popup and side panel here._

## Features

- **Track any page** via the popup button or right-click context menu
- **Background polling** on a configurable interval (1h, 3h, 6h, 12h, or 24h per bookmark)
- **Sentence-level diffing** powered by [diff-match-patch](https://github.com/google/diff-match-patch) and [Readability.js](https://github.com/mozilla/readability)
- **OS notifications** with added/removed sentence counts when a change is detected
- **Side panel diff viewer** showing highlighted `<ins>`/`<del>` content inline
- **Auth wall detection** — skips snapshots where content drops below 20% of the baseline (login redirects, paywalls)
- **Pause/resume** polling per bookmark without losing its snapshot
- **Badge counter** on the extension icon showing unread changes
- **Configurable defaults** — default poll interval, notification toggle, badge toggle

## Tech Stack

| Layer | Technology |
|---|---|
| Extension platform | Chrome Manifest V3 |
| Background | Service Worker (`background/service-worker.js`) |
| Content extraction | Mozilla Readability.js (injected via `chrome.scripting`) |
| Diff engine | Google diff-match-patch |
| Storage | `chrome.storage.local` |
| UI | Vanilla HTML/CSS/JS — popup + side panel |

## Prerequisites

- Google Chrome 114 or later (Manifest V3 + Side Panel API)
- No build step required — plain JavaScript, no bundler

## Getting Started

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `PageDiffBookmark` directory.
5. The extension icon appears in the toolbar. Click it to open the popup.

### Tracking a page

- Navigate to any web page and click **+ Track** in the popup, or right-click the page and choose **Track this page**.
- The extension takes an initial snapshot of the page's readable text content.
- Polling begins automatically according to the configured interval.

### Viewing a diff

- When a change is detected the extension badge shows a count and an OS notification fires.
- Click **View Diff** next to any bookmark in the popup to open the side panel with the full highlighted diff.
- Click **Mark as read** in the side panel to clear the unread indicator.

## Project Structure

```
PageDiffBookmark/
├── background/
│   └── service-worker.js   # Polling engine, diff computation, alarm management
├── content/
│   └── content-script.js   # (Reserved for future content-script use)
├── lib/
│   ├── diff-match-patch.js # Google diff-match-patch library
│   └── Readability.js      # Mozilla Readability library
├── popup/
│   ├── popup.html          # Extension popup UI
│   └── popup.js            # Popup logic — bookmark list, settings panel
├── side-panel/
│   ├── side-panel.html     # Side panel UI
│   └── side-panel.js       # Diff rendering and mark-as-read logic
├── icons/                  # Extension icons (16px, 48px, 128px)
└── manifest.json           # Chrome Manifest V3 configuration
```

## License

MIT — see [LICENSE](LICENSE) for details.

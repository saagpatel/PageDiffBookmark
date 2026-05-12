# PageDiffBookmark — Portfolio Disposition

**Status:** Release Frozen (Chrome Web Store, pre-publish) — Chrome
Manifest V3 extension on `origin/main` with phases 0-2 shipped: page
bookmarking + content extraction (Mozilla Readability), background
polling engine (service worker fetch + diff + notifications), and a
Phase 2 diff viewer with per-bookmark controls and a settings panel.
Side panel UI functional. Repo has the full OSS scaffolding wave on
canonical main (MIT license, security policy, CoC, contributing
guide, Dependabot, issue/PR templates, Makefile, CHANGELOG). **First
member of a new Chrome MV3 extension cluster** — distinct from
desktop signing, iOS App Store, static-host, self-hosted service,
PyPI, local-first pipeline, and operator-tool clusters.

> Disposition uses strict `origin/main` verification.
> **Introduces the Chrome MV3 extension cluster** as the eighth
> top-level disposition cluster.

---

## Verification posture

This repo has **only `origin`** (`saagpatel/PageDiffBookmark`) — no
`legacy-origin` remote. Clean migration state. Local clone's `main`
is tracking `origin/main` correctly.

Specifically verified on `origin/main`:

- Tip: `50447d4` docs: update CLAUDE.md to reflect current project
  state
- **Substantive feat commits** on `origin/main`:
  - `b26ea14` feat(phase2): add diff viewer, per-bookmark controls,
    settings panel
  - `f488662` feat(phase1): add polling engine with background fetch,
    diff, and notifications
  - `5cf566c` fix(phase0): fix service worker load, content extraction,
    and error handling
  - `37ec282` feat(phase0): scaffold extension with bookmark CRUD and
    content extraction
- **OSS scaffolding cadence** (full wave on canonical main):
  - `9563f9d` chore: add initial CHANGELOG
  - `294d7c5` chore: add pull request template
  - `01426c1` chore: add feature request issue template
  - `2c56a47` chore: add bug report issue template
  - `ba3d56d` chore: add Contributor Covenant Code of Conduct
  - `71bf6f6` chore: add .env.example template
  - `85a0e55` chore: add Makefile with standard build targets
  - `d38bda9` chore: add Dependabot configuration
  - `fadbdef` chore: add contributing guidelines
  - `c0b96f8` chore: add security policy
  - `ce4dce4` / `951f22e` MIT license merged
  - `a68f979` / `fe5f009` README docs
- `manifest.json` at repo root (Chrome MV3 manifest)
- Default branch: `main`

---

## Current state in one paragraph

PageDiffBookmark is a Chrome Manifest V3 extension that tracks
arbitrary web pages for content changes. The user bookmarks pages
through the extension; the **service worker** polls each bookmark on
a schedule, extracts page content with **Mozilla Readability.js**,
diffs against the last-stored snapshot using **Google
diff-match-patch**, surfaces sentence-level changes through the
**Chrome side panel** with per-bookmark controls, and fires
**chrome.notifications** when meaningful changes are detected. State
is local — `chrome.storage.local`, no server, no cloud, no
analytics. Phases 0-2 are complete; per README, status is "Work in
Progress" with cross-browser (Firefox / Edge) support as the next
arc and Chrome Web Store publish gated by operator decision. Full
OSS scaffolding (license / contributing / security / CHANGELOG /
Dependabot / templates / Makefile) is already on canonical main —
i.e. the repo is presentable for a Chrome Web Store listing today.

For full detail see `README.md` on `origin/main`.

---

## Why "Release Frozen (Chrome Web Store, pre-publish)" — founds a new cluster

PageDiffBookmark is the first Chrome extension audited. Its
distribution shape is **materially different** from every prior
cluster:

| Aspect | Desktop signing | iOS App Store | **Chrome MV3 extension (new)** |
|---|---|---|---|
| Distribution channel | DMG / GitHub Releases | App Store Connect | **Chrome Web Store** |
| Signing artifact | Apple Developer ID | App Store distribution cert | **Chrome Web Store developer account** (one-time $5 fee, no per-app cert) |
| Review process | Automated notarization | Multi-day human App Store Review | **Chrome Web Store Review** (typically 1-3 days, varies; sometimes auto-approved, sometimes human) |
| Update mechanism | Direct download / Sparkle | App Store auto-update | **Chrome auto-update** (no user action) |
| Permission model | macOS Gatekeeper | iOS sandbox | **MV3 host_permissions + activeTab + storage + notifications** declared in manifest |
| Cross-browser portability | n/a | n/a (iOS-only) | **Manifest portable to Firefox/Edge (mostly), but service worker semantics differ** |
| Background execution | Free | Constrained | **Service worker only** (no persistent background page in MV3) |

The "gate" is therefore not signing or notarization — it's **Chrome
Web Store account + asset preparation + review submission**.

This is the **first member of the Chrome MV3 extension cluster**.
Predicted siblings (per memory): ScreenshottoDataSelect (Chrome MV3
React + Anthropic Vision API), TabTriage (TBD). The cluster will
likely grow to 3 members in the next round or two.

---

## Cluster taxonomy update

This row introduces the **eighth top-level disposition cluster**:

| Cluster | Count | Distribution channel |
|---|---|---|
| Signing (Apple desktop) | 22 | DMG via Apple Developer ID |
| iOS App Store | 3 | App Store Connect |
| Static-host (web, 3 sub-shapes) | 3 | Vercel / Netlify |
| Self-hosted service | 1 | launchd + nginx |
| PyPI distribution | 1 (2 incoming this round) | `pip install` |
| Local-first pipeline | 1 | Worker + adapters |
| Operator-tool / dogfood | 1 | Operator-self |
| **Chrome MV3 extension (new)** | **1** | **Chrome Web Store** |

The portfolio now has **8 distinct distribution shapes**. Future
Chrome extensions in the portfolio batch here.

---

## Unblock trigger (operator)

When ready to ship publicly:

1. **Chrome Web Store developer account.** One-time $5 USD
   registration fee. If the operator already has one for another
   extension, this is zero-effort.
2. **Extension assets:**
   - 128x128 PNG icon (likely already in `manifest.json` icons list)
   - Small + large promotional tiles (440x280, 920x680)
   - At least one 1280x800 or 640x400 screenshot
   - Detailed description (~132 char short + ~16,000 char detailed)
   - Privacy policy URL (already MIT licensed + has security policy
     in repo — privacy posture is local-only, no data exfiltration;
     a one-paragraph privacy statement in repo is sufficient)
3. **Permissions justification** — Chrome Web Store reviewers
   require an explanation for every requested permission. Likely
   permissions in this manifest: `storage`, `notifications`, host
   permissions (or `activeTab`), `sidePanel`. Each needs a one-line
   justification in the developer dashboard.
4. **Cross-browser positioning decision.** The README flags cross-
   browser as a future arc. The operator should decide whether to
   ship Chrome-only first (faster) or wait for Firefox / Edge port
   (broader reach). Recommended: ship Chrome first; Firefox/Edge as
   v1.1.
5. **Manifest version lock.** MV3 only — MV2 is fully deprecated for
   new submissions. Verify `manifest_version: 3`.
6. **Service worker lifecycle audit.** MV3 service workers are
   non-persistent — verify the polling engine handles wake/sleep
   correctly via `chrome.alarms` (not `setInterval`).
7. **Submit for Chrome Web Store Review.**

Estimated operator time once developer account exists: ~3-4 hours
(asset preparation is the bulk; review is async).

---

## Portfolio operating system instructions

| Aspect | Posture |
|---|---|
| Portfolio status | `Release Frozen (Chrome Web Store, pre-publish)` |
| Distribution channel | **Chrome Web Store**, NOT direct download, NOT signing |
| Review cadence | Suspend overdue counting |
| Resurface conditions | (a) Operator submits to Chrome Web Store, (b) review feedback (permission scrutiny especially), (c) Chrome MV3 API change breaks the service worker, (d) cross-browser port (Firefox MV3 / Edge), or (e) v1.1 scope packet |
| Do **not** auto-add to signing / App Store / static-host clusters | Different review pipeline, different distribution channel |
| **New cluster: Chrome MV3 extension** | **First member.** Future Chrome MV3 repos (ScreenshottoDataSelect, TabTriage) batch here. |
| Special concern | **Service worker lifecycle.** MV3's non-persistent service worker is the most common reason MV3 extensions break under load. Verify polling uses `chrome.alarms` API, not in-memory `setInterval`. |
| Special concern | **Permission minimization for review.** Chrome Web Store reviewers reject extensions with broad `<all_urls>` host permissions when narrower `activeTab` + on-demand `chrome.permissions.request` would work. Audit the manifest before submission. |
| Special concern | **Mozilla Readability dependency.** Bundled as vendored JS — verify license compatibility (Mozilla Public License 2.0 vs MIT — both permissive but combinational disclosure may be required in distribution). |
| Special concern | **Cross-browser port semantics.** Firefox MV3 (background.scripts vs service_worker) and Edge MV3 are not 100% identical to Chrome. A `--target firefox` build step is the right scaffolding. |

---

## Why this row founds the Chrome MV3 extension cluster

Every prior cluster boundary was discovered by distribution shape.
Chrome MV3 extension is the cleanest cluster boundary seen so far in
the "browser-resident apps" category:

- Different acquisition (Chrome Web Store, not DMG / App Store /
  pip / npm)
- Different signing (developer account + Chrome's signing
  infrastructure, not Apple Developer ID or App Store cert)
- Different sandboxing (MV3 manifest permissions + content script
  isolation, not OS-level sandbox)
- Different update mechanism (Chrome auto-update, not user-driven
  download or App Store auto-update)
- Different runtime (service worker + content script + side panel,
  not native binary)
- Different review process (Chrome Web Store Review, often
  permission-scrutiny-driven)

No prior cluster member needed Chrome Web Store account setup or MV3
manifest permission justification. This is a new operational lane.

---

## Reactivation procedure (for the next code session)

1. Verify `git branch -vv` shows `main` tracking `origin/main`.
   Already correct as of this disposition pass.
2. Review the local stash (`r12-pagediffbookmark-stash`) — contains
   modifications to `CLAUDE.md` plus untracked `.codex/` and
   `AGENTS.md`. The `AGENTS.md` may have substantive context —
   inspect before discarding.
3. **Inspect `manifest.json`** on canonical main — confirm
   `manifest_version: 3`, audit requested permissions for over-broad
   `<all_urls>` host permissions.
4. **Verify `chrome.alarms`-based polling** (not `setInterval`) for
   MV3 service worker compliance.
5. **Test in Chrome by loading unpacked** from `chrome://extensions`
   with developer mode on.
6. **Test side panel** — Chrome 114+ required.
7. **Audit Readability.js vendored version** for any upstream
   security advisories.
8. **Decide cross-browser scope** before Chrome Web Store
   submission, so the listing copy aligns.

---

## Last known reference

| Field | Value |
|---|---|
| `origin/main` tip | `50447d4` docs: update CLAUDE.md to reflect current project state |
| Last substantive commit | `b26ea14` feat(phase2): add diff viewer, per-bookmark controls, settings panel |
| Default branch | `main` |
| Build system | **Chrome Manifest V3 + Service Worker + Vanilla HTML/CSS/JS** + Makefile |
| Phases shipped | 0 (scaffold + bookmarks + extraction) / 1 (polling + fetch + diff + notifications) / 2 (diff viewer + per-bookmark controls + settings panel + side panel) |
| OSS scaffolding | **Full wave on canonical main** — MIT license, security policy, CoC, contributing, Dependabot, issue/PR templates, Makefile, CHANGELOG, README |
| Distribution channel | **Chrome Web Store** (pre-publish) |
| Dependencies of note | Mozilla Readability.js (vendored), Google diff-match-patch (vendored), `chrome.storage.local`, `chrome.notifications`, `chrome.sidePanel`, `chrome.alarms` (expected) |
| Blocker | Chrome Web Store developer account + permission justification + asset preparation (operator-only) |
| Migration state | **No `legacy-origin` remote** — clean |
| Distinguishing feature | **First Chrome MV3 extension cluster member.** Founds the cluster. Predicted siblings: ScreenshottoDataSelect, TabTriage. |

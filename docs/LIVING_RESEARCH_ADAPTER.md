# Living Research capture adapter

PageDiffBookmark is the browser capture adapter for the Living Research and
Discovery Program. It keeps its existing Readability extraction and
sentence-diff UX, then emits a portable `ResearchCapturePacketV1` for the
KBFreshnessDetector manual research ledger.

Each packet contains stable source identity, canonical locator, source kind,
observation time, status, raw extracted content, declared version when known,
response metadata, extraction warnings/method, content identity, trust and
freshness metadata, and sentence-level diff counts. KBF recomputes canonical
content identities; adapter-provided hashes are advisory provenance.

This adapter admits public HTTP(S) research sources only. Credential-bearing
URLs and common secret-bearing query parameters are rejected before capture or
polling, including for legacy stored bookmarks. Local and syntactically private
network hosts are also rejected. Authenticated/private pages are
not qualified for this capture path. Private knowledge remains in its owning
source and must enter a research package through an explicitly qualified
private retrieval adapter.

Packets are stored under `pdb_research_packet_{bookmarkId}` with append-only
adapter history under `pdb_research_history_{bookmarkId}` and can be read via
the `get-research-packets` runtime message. KBF remains the canonical research
history and review owner.

Scheduling is unarmed by default:

- `DEV_POLL_INTERVAL_MINUTES` is `0`;
- `pdb_settings.automationArmed` defaults to `false`;
- install, track, resume, and interval changes create no alarms unless that
  setting has been explicitly armed in a separately authorized workflow;
- disabling automation clears existing polling alarms, and every alarm callback
  rechecks the exact boolean gate before fetching;
- manual `check-now` remains available for local qualification.

Every observation is retained as a packet: the initial baseline, unchanged
content, material diffs, deletions, rate limits, malformed extraction, and
inaccessible/auth-wall outcomes. Per-source packet history is capped at the
latest 100 observations to stay within `chrome.storage.local` constraints.
Raw extracted content stays local to extension storage, is never transmitted by
this adapter, and is removed with its bookmark. The latest packet plus at most
100 history entries are retained. This is a retention policy for admitted
public sources, not authorization to capture private or authenticated content.

Local adapter verification:

```bash
node --test tests/research-capture.test.js
node --check background/research-capture.js
node --check background/service-worker.js
```

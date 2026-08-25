const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ResearchCapture = require("../background/research-capture.js");

test("stable source identity ignores fragments and tracking parameters", () => {
	const first = ResearchCapture.stableSourceId(
		"https://example.test/policy?utm_source=newsletter&version=2#section",
	);
	const second = ResearchCapture.stableSourceId(
		"https://example.test/policy?version=2",
	);
	assert.equal(first, second);
});

test("canonical locators reject credentials and remove secret query values", () => {
	assert.throws(
		() => ResearchCapture.canonicalizeUrl("https://user:secret@example.test/policy"),
		/credential-bearing/,
	);
	assert.equal(
		ResearchCapture.canonicalizeUrl(
			"https://example.test/policy?version=2&access_token=private&api-key=hidden&key=also-hidden&session=opaque",
		),
		"https://example.test/policy?version=2",
	);
	for (const key of ["sessionId", "authToken", "jwtToken", "refreshToken"]) {
		assert.equal(ResearchCapture.isSensitiveQueryKey(key), true, key);
	}
	assert.throws(
		() =>
			ResearchCapture.admitPublicSourceUrl(
				"https://example.test/policy?refreshToken=private",
			),
		/secret-bearing/,
	);
	for (const url of [
		"http://localhost/policy",
		"http://127.0.0.1/policy",
		"http://10.0.0.2/policy",
		"http://192.168.1.2/policy",
		"http://[::1]/policy",
	]) {
		assert.throws(
			() => ResearchCapture.admitPublicSourceUrl(url),
			/private or local/,
			url,
		);
	}
});

function serviceWorkerHarness({ settings, bookmarks, alarms, fetchImpl = fetch }) {
	const listeners = {};
	const storage = {
		pdb_settings: settings,
		pdb_bookmarks: bookmarks,
	};
	const created = [];
	const cleared = [];
	const event = (name) => ({
		addListener(listener) {
			listeners[name] = listener;
		},
	});
	const chrome = {
		runtime: {
			onInstalled: event("installed"),
			onMessage: event("message"),
		},
		contextMenus: {
			onClicked: event("contextClicked"),
			async removeAll() {},
			create() {},
		},
		storage: {
			local: {
				async get(keys) {
					const requested = Array.isArray(keys) ? keys : [keys];
					return Object.fromEntries(
						requested
							.filter((key) => Object.hasOwn(storage, key))
							.map((key) => [key, storage[key]]),
					);
				},
				async set(values) {
					Object.assign(storage, values);
				},
			},
		},
		alarms: {
			onAlarm: event("alarm"),
			async getAll() {
				return alarms;
			},
			async clear(name) {
				cleared.push(name);
				return true;
			},
			create(name, schedule) {
				created.push({ name, schedule });
			},
		},
		action: {
			async setBadgeText() {},
			async setBadgeBackgroundColor() {},
		},
		notifications: { onClicked: event("notificationClicked") },
	};
	const source = fs.readFileSync(
		path.join(__dirname, "..", "background", "service-worker.js"),
		"utf8",
	);
	const context = {
		AbortController,
		ResearchCapture,
		TextEncoder,
		URL,
		chrome,
		clearTimeout,
		console,
		crypto,
		fetch: fetchImpl,
		importScripts() {},
		setTimeout,
	};
	context.self = context;
	vm.runInNewContext(source, context);
	return { listeners, storage, created, cleared };
}

test("installed scheduling normalizes truthy drift to disarmed and clears stale alarms", async () => {
	const harness = serviceWorkerHarness({
		settings: { automationArmed: "true" },
		bookmarks: [{ id: "source-1", pollIntervalHours: 6, paused: false }],
		alarms: [{ name: "poll_stale" }, { name: "foreign_alarm" }],
	});
	await harness.listeners.installed({ reason: "update" });
	assert.equal(harness.storage.pdb_settings.automationArmed, false);
	assert.deepEqual(harness.cleared, ["poll_stale"]);
	assert.deepEqual(harness.created, []);
});

test("installed scheduling creates polling only for exact true and unpaused sources", async () => {
	const harness = serviceWorkerHarness({
		settings: { automationArmed: true },
		bookmarks: [
			{ id: "active", pollIntervalHours: 6, paused: false },
			{ id: "paused", pollIntervalHours: 6, paused: true },
		],
		alarms: [],
	});
	await harness.listeners.installed({ reason: "update" });
	assert.deepEqual(
		harness.created.map((alarm) => alarm.name),
		["poll_active"],
	);
});

test("alarm callback rechecks the gate and clears stale polling", async () => {
	const harness = serviceWorkerHarness({
		settings: { automationArmed: false },
		bookmarks: [{ id: "source-1", pollIntervalHours: 6, paused: false }],
		alarms: [{ name: "poll_source-1" }],
	});
	await harness.listeners.alarm({ name: "poll_source-1" });
	assert.deepEqual(harness.cleared, ["poll_source-1"]);
});

test("disabling automation through settings clears existing polling alarms", async () => {
	const harness = serviceWorkerHarness({
		settings: { automationArmed: true, badgeEnabled: false },
		bookmarks: [{ id: "source-1", pollIntervalHours: 6, paused: false }],
		alarms: [{ name: "poll_source-1" }],
	});
	const response = await new Promise((resolve) => {
		const asynchronous = harness.listeners.message(
			{ type: "update-settings", settings: { automationArmed: false } },
			{},
			resolve,
		);
		assert.equal(asynchronous, true);
	});
	assert.equal(response.success, true);
	assert.equal(harness.storage.pdb_settings.automationArmed, false);
	assert.deepEqual(harness.cleared, ["poll_source-1"]);
});

test("polling rejects unsafe legacy locators before fetch", async () => {
	let fetchCount = 0;
	const harness = serviceWorkerHarness({
		settings: { automationArmed: false },
		bookmarks: [
			{
				id: "legacy",
				url: "https://example.test/policy?sessionId=private",
				pollIntervalHours: 6,
				paused: false,
			},
		],
		alarms: [],
		fetchImpl: async () => {
			fetchCount += 1;
			throw new Error("fetch must not run");
		},
	});
	const response = await new Promise((resolve) => {
		harness.listeners.message(
			{ type: "check-now", bookmarkId: "legacy" },
			{},
			resolve,
		);
	});
	assert.equal(response.success, false);
	assert.match(response.error, /failed public polling admission/);
	assert.equal(fetchCount, 0);
	assert.deepEqual(harness.cleared, ["poll_legacy"]);
});

test("poll interval mutations reject non-positive and non-finite values", async () => {
	const harness = serviceWorkerHarness({
		settings: { automationArmed: false },
		bookmarks: [{ id: "source-1", pollIntervalHours: 6, paused: false }],
		alarms: [],
	});
	for (const hours of [0, -1, Number.POSITIVE_INFINITY, "6"]) {
		const response = await new Promise((resolve) => {
			harness.listeners.message(
				{ type: "set-poll-interval", bookmarkId: "source-1", hours },
				{},
				resolve,
			);
		});
		assert.equal(response.success, false);
	}
	assert.equal(harness.storage.pdb_bookmarks[0].pollIntervalHours, 6);
});

test("capture packet is portable and review-oriented", async () => {
	const packet = await ResearchCapture.createPacket({
		bookmark: {
			url: "https://example.test/policy?utm_campaign=launch",
			title: "Official policy",
			trust: "authoritative",
			pollIntervalHours: 24,
		},
		content: "Effective date is February 1.",
		observedAt: "2026-08-23T12:00:00Z",
		responseStatus: 200,
		diff: { addedSentences: 1, removedSentences: 1 },
	});
	assert.equal(packet.schema, "ResearchCapturePacketV1");
	assert.equal(packet.source_kind, "html_document");
	assert.equal(packet.locator, "https://example.test/policy");
	assert.equal(packet.source_metadata.trust, "authoritative");
	assert.match(packet.content_identity, /^(sha256|fnv1a32):/);
	assert.deepEqual(packet.page_diff, {
		added_sentences: 1,
		removed_sentences: 1,
	});
});

test("failure packets preserve failure state without inventing content", async () => {
	const packet = await ResearchCapture.createPacket({
		bookmark: { url: "https://example.test/data.json", title: "Dataset" },
		status: "rate_limited",
		content: null,
		responseStatus: 429,
		retryAfterSeconds: 60,
		extractionWarnings: ["provider_rate_limit"],
	});
	assert.equal(packet.status, "rate_limited");
	assert.equal(packet.content, null);
	assert.equal(packet.content_identity, null);
	assert.equal(packet.retry_after_seconds, 60);
});

test("research history is bounded without mutating the caller", () => {
	const original = Array.from({ length: 100 }, (_, index) => ({ index }));
	const bounded = ResearchCapture.appendToHistory(original, { index: 100 });
	assert.equal(original.length, 100);
	assert.equal(bounded.length, 100);
	assert.equal(bounded[0].index, 1);
	assert.equal(bounded.at(-1).index, 100);
});

test("extension scheduling is fail-closed in source", () => {
	const serviceWorker = fs.readFileSync(
		path.join(__dirname, "..", "background", "service-worker.js"),
		"utf8",
	);
	assert.match(serviceWorker, /DEV_POLL_INTERVAL_MINUTES = 0/);
	assert.match(serviceWorker, /automationArmed: false/);
	assert.match(serviceWorker, /settings\?\.automationArmed === true/);
	assert.match(serviceWorker, /if \(automationArmed !== true\) return/);
	assert.match(serviceWorker, /reconcilePollingAlarms\(bookmarks/);
	assert.match(
		serviceWorker,
		/if \(!isAutomationArmed\(settings\)\) \{\s*await chrome\.alarms\.clear\(alarm\.name\);\s*return;/,
	);
	assert.match(serviceWorker, /responseStatus: null/);
	assert.match(serviceWorker, /status: extraction\?\.status \|\| "inaccessible"/);
	assert.match(serviceWorker, /status: "observed",\s*content: extraction\.textContent/);
	assert.match(serviceWorker, /persistResearchPacket\(bookmarkId, researchPacket\)/);
	assert.match(serviceWorker, /researchPacketWrites\.get\(bookmarkId\)/);
});

test("service-worker HTML parsing uses an offscreen DOM boundary", () => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"),
	);
	const serviceWorker = fs.readFileSync(
		path.join(__dirname, "..", "background", "service-worker.js"),
		"utf8",
	);
	const parser = fs.readFileSync(
		path.join(__dirname, "..", "offscreen", "parser.js"),
		"utf8",
	);

	assert.ok(manifest.permissions.includes("offscreen"));
	assert.doesNotMatch(serviceWorker, /new DOMParser\(/);
	assert.match(serviceWorker, /chrome\.offscreen\s*\.createDocument/);
	assert.match(serviceWorker, /parseHtmlOffscreen\(html, url\)/);
	assert.match(parser, /new DOMParser\(\)/);
	assert.match(parser, /new Readability\(document\)\.parse\(\)/);
});

test("every service-worker import resolves from the worker directory", () => {
	const workerDirectory = path.join(__dirname, "..", "background");
	const serviceWorker = fs.readFileSync(
		path.join(workerDirectory, "service-worker.js"),
		"utf8",
	);
	const imports = [...serviceWorker.matchAll(/importScripts\("([^"]+)"\)/g)].map(
		(match) => match[1],
	);

	assert.ok(imports.length > 0);
	for (const importedPath of imports) {
		assert.ok(
			fs.existsSync(path.resolve(workerDirectory, importedPath)),
			`missing worker import: ${importedPath}`,
		);
	}
});

(function attachResearchCapture(root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	}
	root.ResearchCapture = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createApi() {
	"use strict";

	const SCHEMA = "ResearchCapturePacketV1";
	const DEFAULT_HISTORY_LIMIT = 100;
	const SENSITIVE_QUERY_KEY =
		/(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|jwt|key|password|secret|session|sig(?:nature)?|token)(?:$|[_-])/i;

	function isSensitiveQueryKey(key) {
		const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
		return SENSITIVE_QUERY_KEY.test(normalized);
	}

	function isPrivateHostname(hostname) {
		const normalized = hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "")
			.replace(/\.+$/, "");
		if (
			normalized === "localhost" ||
			normalized.endsWith(".localhost") ||
			normalized.endsWith(".local") ||
			normalized.endsWith(".internal") ||
			normalized.endsWith(".home.arpa")
		) {
			return true;
		}
		const ipv4 = normalized.split(".").map(Number);
		if (
			ipv4.length === 4 &&
			ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
		) {
			return (
				ipv4[0] === 0 ||
				ipv4[0] === 10 ||
				ipv4[0] === 127 ||
				(ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127) ||
				(ipv4[0] === 169 && ipv4[1] === 254) ||
				(ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
				(ipv4[0] === 192 && ipv4[1] === 168)
			);
		}
		return (
			normalized === "::1" ||
			normalized.startsWith("::ffff:") ||
			/^(?:fc|fd|fe[89ab])/.test(normalized)
		);
	}

	function stableSourceId(url) {
		let hash = 0xcbf29ce484222325n;
		for (const character of new TextEncoder().encode(canonicalizeUrl(url))) {
			hash ^= BigInt(character);
			hash = BigInt.asUintN(64, hash * 0x100000001b3n);
		}
		return `web-source-${hash.toString(16).padStart(16, "0")}`;
	}

	function inspectUrl(rawUrl) {
		const url = new URL(rawUrl);
		if (!/^https?:$/.test(url.protocol)) {
			throw new Error("research sources must use http or https");
		}
		if (isPrivateHostname(url.hostname)) {
			throw new Error("private or local source hosts are not admitted");
		}
		if (url.username || url.password) {
			throw new Error("credential-bearing source URLs are not admitted");
		}
		url.hash = "";
		const removedSensitiveQueryKeys = [];
		for (const key of [...url.searchParams.keys()]) {
			if (isSensitiveQueryKey(key)) {
				removedSensitiveQueryKeys.push(key);
				url.searchParams.delete(key);
			} else if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
				url.searchParams.delete(key);
			}
		}
		url.searchParams.sort();
		return {
			canonicalUrl: url.toString(),
			removedSensitiveQueryKeys,
		};
	}

	function canonicalizeUrl(rawUrl) {
		return inspectUrl(rawUrl).canonicalUrl;
	}

	function admitPublicSourceUrl(rawUrl) {
		const inspection = inspectUrl(rawUrl);
		if (inspection.removedSensitiveQueryKeys.length > 0) {
			throw new Error("secret-bearing query parameters are not admitted");
		}
		return inspection.canonicalUrl;
	}

	async function contentIdentity(content) {
		const bytes = new TextEncoder().encode(content || "");
		if (globalThis.crypto?.subtle) {
			const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
			return `sha256:${[...new Uint8Array(digest)]
				.map((value) => value.toString(16).padStart(2, "0"))
				.join("")}`;
		}
		let hash = 0x811c9dc5;
		for (const byte of bytes) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
	}

	async function createPacket({
		bookmark,
		status = "observed",
		content = null,
		observedAt = new Date().toISOString(),
		responseStatus = null,
		retryAfterSeconds = null,
		extractionWarnings = [],
		extractionMethod = "readability_service_worker",
		diff = null,
	}) {
		if (!bookmark?.url) throw new Error("bookmark.url is required");
		const sourceId = bookmark.sourceId || stableSourceId(bookmark.url);
		return {
			schema: SCHEMA,
			source_id: sourceId,
			source_kind: bookmark.sourceKind || "html_document",
			locator: canonicalizeUrl(bookmark.url),
			observed_at:
				typeof observedAt === "number"
					? new Date(observedAt).toISOString()
					: observedAt,
			status,
			content,
			declared_version: bookmark.declaredVersion || null,
			response_status: responseStatus,
			retry_after_seconds: retryAfterSeconds,
			extraction_warnings: [...extractionWarnings],
			extraction_method: extractionMethod,
			content_identity: content === null ? null : await contentIdentity(content),
			source_metadata: {
				name: bookmark.title || "Untitled source",
				trust: bookmark.trust || "unknown",
				freshness: bookmark.freshness || {
					max_age_hours: (bookmark.pollIntervalHours || 24) * 2,
					expected_update_pattern: "operator_registered_web_source",
				},
			},
			page_diff: diff
				? {
					added_sentences: diff.addedSentences,
					removed_sentences: diff.removedSentences,
				}
				: null,
		};
	}

	function appendToHistory(history, packet, limit = DEFAULT_HISTORY_LIMIT) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new Error("history limit must be a positive integer");
		}
		return [...(Array.isArray(history) ? history : []), packet].slice(-limit);
	}

	return {
		SCHEMA,
		DEFAULT_HISTORY_LIMIT,
		SENSITIVE_QUERY_KEY,
		appendToHistory,
		canonicalizeUrl,
		contentIdentity,
		createPacket,
		admitPublicSourceUrl,
		inspectUrl,
		isPrivateHostname,
		isSensitiveQueryKey,
		stableSourceId,
	};
});

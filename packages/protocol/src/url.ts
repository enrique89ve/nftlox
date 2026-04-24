// Wire normalization for URLs. The protocol transports image/external URLs
// on-chain with the `https://` prefix stripped to save ~8 bytes per URL per
// custom_json. This module is the single source of truth for that
// transformation: emitters (SDK builders, hashing helpers) call `toWireUrl`
// before putting a value on the wire; readers (SDK IndexerClient) call
// `fromWireUrl` after reading a value back.
//
// Rule:
//   - URLs starting with `https://` (case-insensitive) → prefix stripped.
//   - URLs starting with `http://` → preserved verbatim.
//   - Anything else (already-stripped, non-http scheme) → preserved verbatim.
//
// Inverse rule:
//   - Wire value starting with `http://` or `https://` → returned unchanged.
//   - Anything else → prepended with `https://`.
//
// Round-trip invariant: `fromWireUrl(toWireUrl(x)) === x.trim()` for every
// http(s) URL. This matches the convention already used by the node-endpoint
// normalizer — the protocol treats scheme as redundant state when it can be
// derived from context.

const HTTPS_PREFIX = "https://";
const HTTP_PREFIX = "http://";

function startsWithInsensitive(value: string, prefix: string): boolean {
	if (value.length < prefix.length) return false;
	return value.slice(0, prefix.length).toLowerCase() === prefix;
}

/**
 * Strips the `https://` prefix (case-insensitive) from `fullUrl`. Any other
 * scheme — including `http://`, `data:`, or an already-stripped wire value —
 * passes through unchanged. Leading/trailing whitespace is trimmed.
 *
 * Apply this at the wire boundary before emitting a `ProtocolPayload` or
 * computing a deterministic hash over a URL.
 */
export function toWireUrl(fullUrl: string): string {
	const trimmed = fullUrl.trim();
	if (startsWithInsensitive(trimmed, HTTPS_PREFIX)) {
		return trimmed.slice(HTTPS_PREFIX.length);
	}
	return trimmed;
}

/**
 * Re-adds `https://` when the wire value is scheme-less. Values already
 * carrying `http://` or `https://` are returned unchanged. Whitespace is
 * trimmed before inspection.
 *
 * Apply this when reading URL-bearing fields back from the indexer API so
 * callers receive fully-qualified URLs regardless of on-chain wire form.
 */
export function fromWireUrl(wire: string): string {
	const trimmed = wire.trim();
	if (
		startsWithInsensitive(trimmed, HTTP_PREFIX) ||
		startsWithInsensitive(trimmed, HTTPS_PREFIX)
	) {
		return trimmed;
	}
	return `${HTTPS_PREFIX}${trimmed}`;
}

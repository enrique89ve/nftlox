// Response cache for at-most-once POST semantics on cosigning endpoints.
//
// A bot that times out mid-signing currently has two bad options: retry (and
// re-burn the 24-bit PoW + re-run beekeeper signing), or give up (and forfeit
// any in-flight fee/state). Idempotency-Key lets the server replay the cached
// response in O(1) so retries are cheap and side-effect-free.
//
// Binding the key to a canonical body hash is deliberate: if a client reuses
// a key with a different body, we return a mismatch error rather than replay
// the first response — that would silently send the caller a signature for a
// transaction they didn't ask for.

import { canonicalJson } from "@/utils/canonical-json.ts";

// Stripe-compatible key shape. Short enough to fit comfortably in headers,
// long enough to make collision trivial. `-` and `_` are URL-safe so keys can
// double as query params in client tooling.
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotent-Replay";

export type IdempotencyLookupResult =
	| Readonly<{ type: "hit"; status: number; body: unknown }>
	| Readonly<{ type: "miss" }>
	| Readonly<{ type: "mismatch" }>
	| Readonly<{ type: "invalid_key" }>;

export type IdempotencyCache = Readonly<{
	lookup: (key: string, bodyHash: string, nowMs?: number) => IdempotencyLookupResult;
	store: (key: string, bodyHash: string, status: number, body: unknown, nowMs?: number) => void;
	size: () => number;
}>;

export type IdempotencyCacheOptions = Readonly<{
	ttlMs: number;
	maxEntries: number;
}>;

type CacheEntry = Readonly<{
	bodyHash: string;
	status: number;
	body: unknown;
	expiresAt: number;
}>;

export function isValidIdempotencyKey(value: unknown): value is string {
	return typeof value === "string" && KEY_PATTERN.test(value);
}

export async function hashIdempotencyBody(body: unknown): Promise<string> {
	const json = canonicalJson(body as Record<string, unknown>);
	if (json === undefined) throw new TypeError("Idempotency body must be JSON serializable");
	const encoded = new TextEncoder().encode(json);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

export function createIdempotencyCache(options: IdempotencyCacheOptions): IdempotencyCache {
	const { ttlMs, maxEntries } = options;
	// Map preserves insertion order, so FIFO eviction is free — no need for an
	// extra LRU bookkeeping layer when the access pattern is "write once, read
	// maybe once on retry, then expire".
	const entries = new Map<string, CacheEntry>();

	function evictExpired(nowMs: number): void {
		for (const [key, entry] of entries) {
			if (entry.expiresAt > nowMs) break;
			entries.delete(key);
		}
	}

	function evictOverflow(): void {
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}

	return {
		lookup(key, bodyHash, nowMs = Date.now()) {
			if (!isValidIdempotencyKey(key)) return { type: "invalid_key" };
			evictExpired(nowMs);
			const entry = entries.get(key);
			if (!entry) return { type: "miss" };
			if (entry.bodyHash !== bodyHash) return { type: "mismatch" };
			return { type: "hit", status: entry.status, body: entry.body };
		},
		store(key, bodyHash, status, body, nowMs = Date.now()) {
			if (!isValidIdempotencyKey(key)) return;
			entries.set(key, { bodyHash, status, body, expiresAt: nowMs + ttlMs });
			evictOverflow();
		},
		size: () => entries.size,
	};
}

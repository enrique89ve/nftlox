import { describe, expect, test } from "bun:test";

import {
	createIdempotencyCache,
	hashIdempotencyBody,
	isValidIdempotencyKey,
} from "@/api/services/idempotency-cache.ts";

describe("isValidIdempotencyKey", () => {
	test("accepts stripe-style keys of 16..128 chars", () => {
		expect(isValidIdempotencyKey("a".repeat(16))).toBe(true);
		expect(isValidIdempotencyKey("a".repeat(128))).toBe(true);
		expect(isValidIdempotencyKey("abc-XYZ_123-4567890_")).toBe(true);
	});

	test("rejects short, long, empty, non-string, or invalid-character keys", () => {
		expect(isValidIdempotencyKey("short")).toBe(false);
		expect(isValidIdempotencyKey("a".repeat(129))).toBe(false);
		expect(isValidIdempotencyKey("")).toBe(false);
		expect(isValidIdempotencyKey(null)).toBe(false);
		expect(isValidIdempotencyKey(undefined)).toBe(false);
		expect(isValidIdempotencyKey(123)).toBe(false);
		// Disallowed characters — spaces, punctuation, unicode
		expect(isValidIdempotencyKey("has space 1234567890abc")).toBe(false);
		expect(isValidIdempotencyKey("has$dollar$1234567890abc")).toBe(false);
	});
});

describe("hashIdempotencyBody", () => {
	test("produces identical hashes for semantically equal objects", async () => {
		const a = await hashIdempotencyBody({ a: 1, b: 2, nested: { x: [1, 2] } });
		const b = await hashIdempotencyBody({ b: 2, nested: { x: [1, 2] }, a: 1 });
		expect(a).toBe(b);
	});

	test("produces different hashes for different bodies", async () => {
		const a = await hashIdempotencyBody({ creator: "alice", symbol: "FOO" });
		const b = await hashIdempotencyBody({ creator: "alice", symbol: "BAR" });
		expect(a).not.toBe(b);
	});

	test("hash is 64 hex chars (sha256)", async () => {
		const hash = await hashIdempotencyBody({ any: "value" });
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("createIdempotencyCache", () => {
	const KEY_A = "a".repeat(16);
	const KEY_B = "b".repeat(16);

	test("returns miss for an unknown key", () => {
		const cache = createIdempotencyCache({ ttlMs: 10_000, maxEntries: 10 });
		const result = cache.lookup(KEY_A, "hash1");
		expect(result.type).toBe("miss");
	});

	test("stores and returns a response on matching (key, bodyHash)", () => {
		const cache = createIdempotencyCache({ ttlMs: 10_000, maxEntries: 10 });
		cache.store(KEY_A, "hash1", 200, { ok: true, signature: "sig" });
		const result = cache.lookup(KEY_A, "hash1");
		expect(result).toEqual({ type: "hit", status: 200, body: { ok: true, signature: "sig" } });
	});

	test("returns mismatch when same key is replayed with a different body hash", () => {
		const cache = createIdempotencyCache({ ttlMs: 10_000, maxEntries: 10 });
		cache.store(KEY_A, "hash1", 200, { ok: true });
		const result = cache.lookup(KEY_A, "different-hash");
		expect(result.type).toBe("mismatch");
	});

	test("evicts entries past ttlMs", () => {
		const cache = createIdempotencyCache({ ttlMs: 1_000, maxEntries: 10 });
		cache.store(KEY_A, "hash1", 200, { ok: true }, 0);
		expect(cache.lookup(KEY_A, "hash1", 500).type).toBe("hit");
		expect(cache.lookup(KEY_A, "hash1", 2_000).type).toBe("miss");
	});

	test("evicts oldest entries when size exceeds maxEntries", () => {
		const cache = createIdempotencyCache({ ttlMs: 10_000, maxEntries: 2 });
		cache.store(KEY_A, "hash1", 200, { a: 1 });
		cache.store(KEY_B, "hash2", 200, { b: 2 });
		cache.store("c".repeat(16), "hash3", 200, { c: 3 });
		expect(cache.size()).toBe(2);
		expect(cache.lookup(KEY_A, "hash1").type).toBe("miss");
		expect(cache.lookup(KEY_B, "hash2").type).toBe("hit");
		expect(cache.lookup("c".repeat(16), "hash3").type).toBe("hit");
	});

	test("invalid keys are rejected at lookup and silently ignored at store", () => {
		const cache = createIdempotencyCache({ ttlMs: 10_000, maxEntries: 10 });
		expect(cache.lookup("short", "hash1").type).toBe("invalid_key");
		cache.store("short", "hash1", 200, { ok: true });
		expect(cache.size()).toBe(0);
	});
});

import { describe, expect, test } from "bun:test";
import {
	SYNC_HA_LOCK_ID,
	SYNC_WRITE_FENCE_ID,
	isSyncLockLostError,
	syncLockLostError,
} from "@/scanner/sync-lock.ts";

// These tests stay pure — no Postgres, no module-level fixtures — so they
// guard the invariants that matter for HA correctness regardless of test
// environment availability. The acquire / release lifecycle (which DOES
// touch a real connection) is exercised through the broader integration
// suite that owns DB setup.

describe("sync-lock invariants", () => {
	// The HA session lock and the per-batch xact fence MUST be distinct keys.
	// Both `pg_advisory_lock` and `pg_advisory_xact_lock` share a single
	// keyspace, so reusing the same id would make a pool connection
	// (session B) deadlock against the dedicated HA connection (session A)
	// the moment it tried to take the xact lock.
	test("SYNC_HA_LOCK_ID and SYNC_WRITE_FENCE_ID must be distinct", () => {
		expect(SYNC_HA_LOCK_ID).not.toBe(SYNC_WRITE_FENCE_ID);
	});

	test("both lock IDs are positive integers", () => {
		for (const id of [SYNC_HA_LOCK_ID, SYNC_WRITE_FENCE_ID]) {
			expect(typeof id).toBe("number");
			expect(Number.isInteger(id)).toBe(true);
			expect(id).toBeGreaterThan(0);
		}
	});
});

describe("syncLockLostError / isSyncLockLostError", () => {
	test("syncLockLostError produces an Error subclass", () => {
		const err = syncLockLostError("session lock dropped");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("session lock dropped");
	});

	test("isSyncLockLostError recognises produced errors", () => {
		expect(isSyncLockLostError(syncLockLostError("x"))).toBe(true);
	});

	test("isSyncLockLostError rejects unrelated values", () => {
		expect(isSyncLockLostError(new Error("regular error"))).toBe(false);
		expect(isSyncLockLostError(null)).toBe(false);
		expect(isSyncLockLostError(undefined)).toBe(false);
		expect(isSyncLockLostError("string")).toBe(false);
		expect(isSyncLockLostError({})).toBe(false);
	});

	// A plain object that copies the shape of the marker symbol must NOT pass
	// the guard — `isSyncLockLostError` requires the value to also be an
	// Error instance, so an attacker-influenced payload deserialised from
	// JSON cannot impersonate a sync-lock-lost signal.
	test("isSyncLockLostError requires Error instance, not just the symbol", () => {
		const tag = Symbol.for("nftlox.sync.lock.lost");
		const fake = { [tag]: true };
		expect(isSyncLockLostError(fake)).toBe(false);
	});

	// The symbol identity is registered via Symbol.for so cross-realm /
	// duplicate-module loads still produce the same key. Reaching in through
	// a freshly-resolved Symbol.for and stamping it onto an Error should
	// therefore satisfy the guard — this codifies the cross-realm contract
	// the implementation depends on.
	test("Symbol.for marker is cross-realm reachable and structurally tagging", () => {
		const tag = Symbol.for("nftlox.sync.lock.lost");
		const err = new Error("manually tagged") as Error & {
			[k: symbol]: true;
		};
		Object.defineProperty(err, tag, {
			value: true,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		expect(isSyncLockLostError(err)).toBe(true);
	});

	test("preserves a cause when provided", () => {
		const cause = new Error("connection closed");
		const err = syncLockLostError("session lock dropped", cause);
		expect((err as Error & { cause?: unknown }).cause).toBe(cause);
	});

	test("omits cause when not provided", () => {
		const err = syncLockLostError("standalone");
		expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
	});
});

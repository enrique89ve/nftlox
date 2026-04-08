import { describe, expect, test } from "bun:test";
import { evaluateSyncHealth } from "@/health/sync-health.ts";

const nowMs = Date.parse("2026-04-07T12:00:00.000Z");

describe("evaluateSyncHealth", () => {
	test("returns ready when already in sync", () => {
		const health = evaluateSyncHealth({
			nowMs,
			startupTimeMs: nowMs - 300_000,
			lastUpdateTimeMs: nowMs - 120_000,
			lastBlock: 1_000,
			headBlock: 1_000,
			irreversibleBlock: 1_000,
			toleranceBlocks: 5,
		});

		expect(health.inSync).toBe(true);
		expect(health.live).toBe(true);
		expect(health.ready).toBe(true);
		expect(health.syncState).toBe("ready");
	});

	test("returns catching-up when there is recent post-startup activity", () => {
		const health = evaluateSyncHealth({
			nowMs,
			startupTimeMs: nowMs - 60_000,
			lastUpdateTimeMs: nowMs - 10_000,
			lastBlock: 900,
			headBlock: 1_000,
			irreversibleBlock: 1_000,
			toleranceBlocks: 5,
		});

		expect(health.inSync).toBe(false);
		expect(health.syncActive).toBe(true);
		expect(health.live).toBe(true);
		expect(health.ready).toBe(false);
		expect(health.syncState).toBe("catching-up");
	});

	test("returns stale when there has been no recent activity", () => {
		const health = evaluateSyncHealth({
			nowMs,
			startupTimeMs: nowMs - 300_000,
			lastUpdateTimeMs: nowMs - 120_000,
			lastBlock: 900,
			headBlock: 1_000,
			irreversibleBlock: 1_000,
			toleranceBlocks: 5,
		});

		expect(health.inSync).toBe(false);
		expect(health.syncActive).toBe(false);
		expect(health.live).toBe(false);
		expect(health.ready).toBe(false);
		expect(health.syncState).toBe("stale");
	});
});

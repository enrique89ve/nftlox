import { describe, test, expect, beforeEach } from "bun:test";
import {
	isSynced,
	setSynced,
	getSyncProgress,
	updateSyncProgress,
	setStartupTime,
	getStartupTime,
} from "@/scanner/sync-state.ts";

describe("sync-state", () => {
	beforeEach(() => {
		setSynced(false);
		updateSyncProgress(0, 0);
	});

	test("starts as not synced", () => {
		expect(isSynced()).toBe(false);
	});

	test("setSynced toggles state", () => {
		setSynced(true);
		expect(isSynced()).toBe(true);
		setSynced(false);
		expect(isSynced()).toBe(false);
	});

	test("getSyncProgress returns correct values", () => {
		updateSyncProgress(100, 200);
		const progress = getSyncProgress();
		expect(progress.lastBlock).toBe(100);
		expect(progress.headBlock).toBe(200);
		expect(progress.behind).toBe(100);
	});

	test("behind is clamped to 0 when lastBlock >= headBlock", () => {
		updateSyncProgress(200, 200);
		expect(getSyncProgress().behind).toBe(0);

		updateSyncProgress(201, 200);
		expect(getSyncProgress().behind).toBe(0);
	});

	test("setStartupTime records timestamp", () => {
		const before = Date.now();
		setStartupTime();
		const after = Date.now();
		expect(getStartupTime()).toBeGreaterThanOrEqual(before);
		expect(getStartupTime()).toBeLessThanOrEqual(after);
	});
});

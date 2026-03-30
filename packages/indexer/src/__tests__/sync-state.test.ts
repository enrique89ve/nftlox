import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
	isSynced,
	setSynced,
	getSyncProgress,
	updateSyncProgress,
	setStartupTime,
	getStartupTime,
	setSyncReporter,
} from "@/scanner/sync-state.ts";

describe("sync-state", () => {
	beforeEach(() => {
		setSyncReporter(null as any);
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

describe("sync-state reporter (worker mode)", () => {
	beforeEach(() => {
		setSyncReporter(null as any);
		setSynced(false);
		updateSyncProgress(0, 0);
	});

	test("should call onProgress when updateSyncProgress is called", () => {
		const onProgress = mock(() => {});
		const onSyncedChange = mock(() => {});
		setSyncReporter({ onProgress, onSyncedChange });

		updateSyncProgress(100, 200);

		expect(onProgress).toHaveBeenCalledWith(100, 200);
		expect(onProgress).toHaveBeenCalledTimes(1);
	});

	test("should call onSyncedChange when setSynced is called", () => {
		const onProgress = mock(() => {});
		const onSyncedChange = mock(() => {});
		setSyncReporter({ onProgress, onSyncedChange });

		setSynced(true);
		expect(onSyncedChange).toHaveBeenCalledWith(true);

		setSynced(false);
		expect(onSyncedChange).toHaveBeenCalledWith(false);
		expect(onSyncedChange).toHaveBeenCalledTimes(2);
	});

	test("should not fail when no reporter is set", () => {
		setSyncReporter(null as any);

		expect(() => {
			updateSyncProgress(100, 200);
			setSynced(true);
		}).not.toThrow();
	});
});

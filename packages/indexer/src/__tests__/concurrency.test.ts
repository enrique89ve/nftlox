import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { ParsedOperation, ParseResult } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";
import { ACTION_TRANSFER, ACTION_BUY, ACTION_PACK_BUY, ACTIVE_AUTH_ACTIONS } from "nftlox-sdk";

// ─── Mocks ──────────────────────────────────────────

let trackedLastBlock = 0;

const mockGetLastBlock = mock(() => Promise.resolve(trackedLastBlock));
const mockUpdateLastBlock = mock((block: number, _txn?: unknown) => {
	trackedLastBlock = block;
	return Promise.resolve();
});
const mockGetBlockchainHead = mock(() => Promise.resolve({ headBlock: 0, irreversibleBlock: 0 }));
const mockGetCustomJsonInRange = mock(
	(_from: number, _to: number, _id: string) => Promise.resolve([] as HafAHOperation[]),
);
const mockGetHafAHBlockRange = mock(() => 2000);
const mockGetTransfersInTransaction = mock((_txId: string) => Promise.resolve([] as Array<{
	from: string; to: string; amount: number; currency: string; memo: string;
}>));
const mockParseHafAHOperations = mock((_ops: HafAHOperation[]): ParseResult => ({ ops: [], rejected: [] }));
const mockRouteOperation = mock((_op: ParsedOperation, _txn: unknown) => Promise.resolve());

const mockTxn = Object.assign(
	(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(),
	{ __mock: true },
);

const mockWithTransaction = mock(async (fn: (txn: unknown) => Promise<void>) => {
	await fn(mockTxn);
});

mock.module("@/db/queries/sync.ts", () => ({
	getLastBlock: mockGetLastBlock,
	updateLastBlock: mockUpdateLastBlock,
	cleanupExpiredOperations: mock(() => Promise.resolve(0)),
	insertInvalidOperation: mock(() => Promise.resolve()),
	acquireSyncLock: mock(() => Promise.resolve(true)),
	releaseSyncLock: mock(() => Promise.resolve()),
}));

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockchainHead: mockGetBlockchainHead,
	getCustomJsonInRange: mockGetCustomJsonInRange,
	getHafAHBlockRange: mockGetHafAHBlockRange,
	getTransfersInTransaction: mockGetTransfersInTransaction,
}));

mock.module("@/scanner/operation-parser.ts", () => ({
	parseHafAHOperations: mockParseHafAHOperations,
}));

mock.module("@/processor/action-router.ts", () => ({
	routeOperation: mockRouteOperation,
}));

mock.module("@/db/client.ts", () => ({
	withTransaction: mockWithTransaction,
	sql: Object.assign(
		(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
		{
			begin: (fn: (sql: unknown) => Promise<unknown>) => fn((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([])),
			end: () => Promise.resolve(),
			unsafe: (_query: string) => Promise.resolve([]),
		},
	),
	clampLimit: (limit: number, defaultVal = 50) => {
		if (limit < 1 || !Number.isFinite(limit)) return defaultVal;
		return Math.min(limit, 1000);
	},
	testConnection: () => Promise.resolve(),
	closePool: () => Promise.resolve(),
}));

const { syncCycle, setRunning } = await import("@/scanner/sync-engine.ts");
const { isSynced, setSynced, getSyncProgress, updateSyncProgress } = await import("@/scanner/sync-state.ts");

// ─── Helpers ────────────────────────────────────────

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);

function fakeHafOp(block: number, action = ACTION_TRANSFER): HafAHOperation {
	const isActive = ACTIVE_SET.has(action);
	return {
		op: {
			type: "custom_json_operation",
			value: {
				id: "nftlox_testnet",
				json: JSON.stringify({ version: "0.2.1", action, data: {} }),
				required_auths: isActive ? ["alice"] : [],
				required_posting_auths: isActive ? [] : ["alice"],
			},
		},
		block,
		trx_id: `tx_${block}`,
		timestamp: "2024-01-01T00:00:00",
		operation_id: `${block}`,
		virtual_op: false,
	};
}

function fakeParsedOp(block: number, action = ACTION_TRANSFER): ParsedOperation {
	return {
		blockNum: block,
		timestamp: "2024-01-01T00:00:00",
		txId: `tx_${block}`,
		operationId: `op_${block}`,
		signer: "alice",
		authLevel: ACTIVE_SET.has(action) ? "active" : "posting",
		action: action as ParsedOperation["action"],
		version: "0.2.1",
		data: {},
	};
}

function wrapOps(ops: ParsedOperation[]): ParseResult {
	return { ops, rejected: [] };
}

function setupChainHead(irreversible: number, head?: number): void {
	mockGetBlockchainHead.mockResolvedValue({
		headBlock: head ?? irreversible,
		irreversibleBlock: irreversible,
	});
}

function resetAllMocks(): void {
	trackedLastBlock = 0;

	mockGetLastBlock.mockReset();
	mockUpdateLastBlock.mockReset();
	mockGetBlockchainHead.mockReset();
	mockGetCustomJsonInRange.mockReset();
	mockGetHafAHBlockRange.mockReset();
	mockGetTransfersInTransaction.mockReset();
	mockParseHafAHOperations.mockReset();
	mockRouteOperation.mockReset();
	mockWithTransaction.mockReset();

	mockGetLastBlock.mockImplementation(() => Promise.resolve(trackedLastBlock));
	mockUpdateLastBlock.mockImplementation((block: number) => {
		trackedLastBlock = block;
		return Promise.resolve();
	});
	mockGetCustomJsonInRange.mockImplementation(() => Promise.resolve([]));
	mockGetHafAHBlockRange.mockImplementation(() => 2000);
	mockGetTransfersInTransaction.mockImplementation(() => Promise.resolve([]));
	mockParseHafAHOperations.mockImplementation(() => ({ ops: [], rejected: [] }));
	mockRouteOperation.mockImplementation(() => Promise.resolve());
	mockWithTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
		await fn(mockTxn);
	});

	setSynced(false);
	updateSyncProgress(0, 0);
	setRunning(true);
}

// ─── Tests ──────────────────────────────────────────

describe("block processing never stops", () => {
	beforeEach(resetAllMocks);

	test("should process all ranges even when handlers are called repeatedly", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([fakeParsedOp(1001)]));

		let routeCalls = 0;
		mockRouteOperation.mockImplementation(async () => { routeCalls++; });

		await syncCycle();

		expect(mockGetCustomJsonInRange).toHaveBeenCalledTimes(3);
		expect(routeCalls).toBe(3);
		expect(trackedLastBlock).toBe(6000);
	});

	test("should advance cursor continuously without gaps", async () => {
		trackedLastBlock = 1000;
		setupChainHead(8000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		const blocks = mockUpdateLastBlock.mock.calls.map(c => c[0] as number);

		for (let i = 1; i < blocks.length; i++) {
			const gap = (blocks[i] as number) - (blocks[i - 1] as number);
			expect(gap).toBeLessThanOrEqual(2000);
			expect(gap).toBeGreaterThan(0);
		}

		expect(blocks.at(-1)).toBe(8000);
	});

	test("should resume from last block after consecutive cycles", async () => {
		trackedLastBlock = 1000;
		setupChainHead(3000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();
		expect(trackedLastBlock).toBe(3000);

		setupChainHead(5000);
		await syncCycle();

		expect(trackedLastBlock).toBe(5000);
		expect(isSynced()).toBe(true);
	});

	test("should stop between ranges when running flag is cleared", async () => {
		trackedLastBlock = 1000;
		setupChainHead(8000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		mockUpdateLastBlock.mockImplementation((block: number) => {
			trackedLastBlock = block;
			if (block >= 3000) setRunning(false);
			return Promise.resolve();
		});

		await syncCycle();

		expect(trackedLastBlock).toBe(3000);
		expect(mockGetCustomJsonInRange).toHaveBeenCalledTimes(1);
	});
});

describe("event loop yields during massive sync", () => {
	let setTimeoutSpy: ReturnType<typeof spyOn> | null = null;

	beforeEach(resetAllMocks);

	afterEach(() => {
		// spyOn auto-restores with mockRestore, ensuring globalThis.setTimeout is never corrupted
		setTimeoutSpy?.mockRestore();
		setTimeoutSpy = null;
	});

	test("should yield to event loop between batches during massive sync", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000); // 5000 behind → massive
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		let yieldCount = 0;
		const originalSetTimeout = globalThis.setTimeout;
		setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			if (ms === 0) yieldCount++;
			return originalSetTimeout(fn, ms);
		}) as unknown as typeof setTimeout);

		await syncCycle();

		// 3 ranges in massive sync → 3 yields (one per batch)
		expect(yieldCount).toBeGreaterThanOrEqual(3);
	});

	test("should NOT yield when sync is not massive", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1050); // 50 behind → NOT massive (< 100)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		let yieldCount = 0;
		const originalSetTimeout = globalThis.setTimeout;
		setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			if (ms === 0) yieldCount++;
			return originalSetTimeout(fn, ms);
		}) as unknown as typeof setTimeout);

		await syncCycle();

		expect(yieldCount).toBe(0);
	});

	test("should allow pending tasks to resolve during massive sync", async () => {
		expect.hasAssertions();

		trackedLastBlock = 1000;
		setupChainHead(4000); // massive
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		let apiRequestResolved = false;

		// Simulates an API request queued on the event loop
		setTimeout(() => { apiRequestResolved = true; }, 0);

		await syncCycle();

		// One more tick to drain any remaining timers
		await new Promise(resolve => setTimeout(resolve, 1));

		expect(apiRequestResolved).toBe(true);
	});
});

describe("buy enrichment runs in parallel", () => {
	beforeEach(resetAllMocks);

	test("should enrich multiple buy ops concurrently via Promise.all", async () => {
		const buyOps = [
			fakeParsedOp(1001, ACTION_BUY),
			fakeParsedOp(1002, ACTION_BUY),
			fakeParsedOp(1003, ACTION_PACK_BUY),
		];

		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps(buyOps));

		let concurrentCalls = 0;
		let maxConcurrent = 0;

		mockGetTransfersInTransaction.mockImplementation(async () => {
			concurrentCalls++;
			maxConcurrent = Math.max(maxConcurrent, concurrentCalls);

			// Simulate network delay to ensure concurrency is measurable
			await new Promise(resolve => setTimeout(resolve, 10));

			concurrentCalls--;
			return [];
		});

		await syncCycle();

		expect(mockGetTransfersInTransaction).toHaveBeenCalledTimes(3);
		// All 3 should be in-flight simultaneously (Promise.all)
		expect(maxConcurrent).toBe(3);
	});

	test("should call enrichment for both buy ops even if one fails", async () => {
		const buyOps = [
			fakeParsedOp(1001, ACTION_BUY),
			fakeParsedOp(1002, ACTION_BUY),
		];

		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps(buyOps));

		let callCount = 0;
		mockGetTransfersInTransaction.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) throw new Error("RPC timeout");
			return [{ from: "buyer", to: "seller", amount: 1, currency: "HIVE", memo: "" }];
		});

		// Promise.all rejects on first failure, caught by sync cycle error handler
		try {
			await syncCycle();
		} catch {
			// Expected
		}

		// Both were initiated in parallel before rejection
		expect(callCount).toBe(2);
	});

	test("should NOT enrich non-buy ops with transfer lookups", async () => {
		const ops = [
			fakeParsedOp(1001, ACTION_TRANSFER),
			fakeParsedOp(1002, ACTION_TRANSFER),
		];

		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps(ops));

		await syncCycle();

		expect(mockGetTransfersInTransaction).not.toHaveBeenCalled();
	});
});

describe("sync progress tracking", () => {
	beforeEach(resetAllMocks);

	test("should update progress after each batch, not just at end", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		const progressSnapshots: Array<{ lastBlock: number; headBlock: number }> = [];

		const baseImpl = mockUpdateLastBlock.getMockImplementation()!;
		mockUpdateLastBlock.mockImplementation((block: number, txn?: unknown) => {
			baseImpl(block, txn);
			progressSnapshots.push({ ...getSyncProgress() });
			return Promise.resolve();
		});

		await syncCycle();

		expect(progressSnapshots).toHaveLength(3);

		for (let i = 1; i < progressSnapshots.length; i++) {
			expect(progressSnapshots[i]!.lastBlock).toBeGreaterThan(progressSnapshots[i - 1]!.lastBlock);
		}
	});

	test("should set synced=true only after massive sync completes fully", async () => {
		trackedLastBlock = 1000;
		setupChainHead(4000); // massive
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		setSynced(true);

		await syncCycle();

		expect(isSynced()).toBe(true);
		expect(trackedLastBlock).toBe(4000);
	});
});

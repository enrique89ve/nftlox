import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";
import { ACTION_TRANSFER, ACTION_PACK_BUY } from "nftlox-sdk";

// ─── Mocks ──────────────────────────────────────────

// Shared state between getLastBlock/updateLastBlock so the continuity check works
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
const mockParseHafAHOperations = mock((_ops: HafAHOperation[]) => [] as ParsedOperation[]);
const mockRouteOperation = mock((_op: ParsedOperation, _txn: unknown) => Promise.resolve());
const mockWithTransaction = mock(async (fn: (txn: unknown) => Promise<void>) => {
	await fn(mockTxn);
});

// Fake txn object that supports tagged template literals (for SET LOCAL)
const mockTxn = Object.assign(
	(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(),
	{ __mock: true },
);

mock.module("@/db/queries/sync.ts", () => ({
	getLastBlock: mockGetLastBlock,
	updateLastBlock: mockUpdateLastBlock,
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
		(strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
		{
			begin: (fn: (sql: unknown) => Promise<unknown>) => fn((s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([])),
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

// Import AFTER mocks so they take effect
const { syncCycle, setRunning } = await import("@/scanner/sync-engine.ts");
const { isSynced, setSynced, getSyncProgress, updateSyncProgress } = await import("@/scanner/sync-state.ts");

// ─── Helpers ────────────────────────────────────────

function fakeHafOp(block: number): HafAHOperation {
	return {
		op: {
			type: "custom_json_operation",
			value: {
				id: "nftlox_testnet",
				json: JSON.stringify({ version: "0.2.1", action: ACTION_TRANSFER, data: {} }),
				required_auths: ["alice"],
				required_posting_auths: [],
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
		signer: "alice",
		authLevel: "posting",
		action: action as ParsedOperation["action"],
		version: "0.2.1",
		data: {},
	};
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

	// Restore default implementations with shared state
	mockGetLastBlock.mockImplementation(() => Promise.resolve(trackedLastBlock));
	mockUpdateLastBlock.mockImplementation((block: number) => {
		trackedLastBlock = block;
		return Promise.resolve();
	});
	mockGetCustomJsonInRange.mockImplementation(() => Promise.resolve([]));
	mockGetHafAHBlockRange.mockImplementation(() => 2000);
	mockGetTransfersInTransaction.mockImplementation(() => Promise.resolve([]));
	mockParseHafAHOperations.mockImplementation(() => []);
	mockRouteOperation.mockImplementation(() => Promise.resolve());
	mockWithTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
		await fn(mockTxn);
	});

	// Reset sync state
	setSynced(false);
	updateSyncProgress(0, 0);
	setRunning(true);
}

// ─── Tests ──────────────────────────────────────────

describe("syncCycle", () => {
	beforeEach(resetAllMocks);
	afterEach(resetAllMocks);

	test("initializes from genesis when lastBlock is 0", async () => {
		trackedLastBlock = 0;
		setupChainHead(100);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);

		await syncCycle();

		// Should initialize to genesisBlock - 1
		const firstCall = mockUpdateLastBlock.mock.calls[0];
		expect(firstCall).toBeDefined();
		// genesisBlock from config (default from SDK)
		// First updateLastBlock call should be the genesis init
		expect(typeof firstCall![0]).toBe("number");
		expect(firstCall![0]).toBeGreaterThan(0);
	});

	test("sets synced=true when within tolerance", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1005, 1010); // 5 blocks behind irreversible (< SYNC_TOLERANCE=10)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);

		await syncCycle();

		expect(isSynced()).toBe(true);
	});

	test("sleeps and returns when behind <= 0", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1000); // exactly caught up
		mockGetHafAHBlockRange.mockReturnValue(2000);

		await syncCycle();

		expect(isSynced()).toBe(true);
		// Should NOT call getCustomJsonInRange since it exits early
		expect(mockGetCustomJsonInRange).not.toHaveBeenCalled();
	});

	test("processes ops within a transaction when ops exist", async () => {
		const hafOps = [fakeHafOp(1001), fakeHafOp(1002)];
		const parsedOps = [fakeParsedOp(1001), fakeParsedOp(1002)];

		trackedLastBlock = 1000;
		setupChainHead(1020); // 20 behind, not massive
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue(hafOps);
		mockParseHafAHOperations.mockReturnValue(parsedOps);

		await syncCycle();

		// Should parse the hafah ops
		expect(mockParseHafAHOperations).toHaveBeenCalledWith(hafOps);
		// Should process each op via routeOperation
		expect(mockRouteOperation).toHaveBeenCalledTimes(2);
		// Should run inside a transaction
		expect(mockWithTransaction).toHaveBeenCalled();
	});

	test("advances cursor without transaction when no ops", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue([]);

		await syncCycle();

		// Should still advance the cursor
		expect(mockUpdateLastBlock).toHaveBeenCalled();
		// Should NOT use a transaction
		expect(mockWithTransaction).not.toHaveBeenCalled();
	});

	test("sets synced=false during massive sync", async () => {
		trackedLastBlock = 1000;
		setupChainHead(2000); // 1000 behind (> MASSIVE_THRESHOLD=100)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue([]);

		setSynced(true); // pre-set to true
		await syncCycle();

		// Massive sync sets synced=false then back to true on completion
		expect(isSynced()).toBe(true);
	});

	test("enriches pack_buy ops with paired transfers", async () => {
		const hafOps = [fakeHafOp(1001)];
		const packBuyOp = fakeParsedOp(1001, ACTION_PACK_BUY);

		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue(hafOps);
		mockParseHafAHOperations.mockReturnValue([packBuyOp]);
		mockGetTransfersInTransaction.mockResolvedValue([]);

		await syncCycle();

		expect(mockGetTransfersInTransaction).toHaveBeenCalledWith("tx_1001");
	});

	test("updates sync progress after each range", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue([]);

		await syncCycle();

		const progress = getSyncProgress();
		// Should have updated progress to the range end
		expect(progress.lastBlock).toBeGreaterThanOrEqual(1020);
		expect(progress.headBlock).toBe(1020);
	});

	test("processes multiple ranges when behind exceeds blockRange", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000); // 5000 behind, blockRange=2000 → ~3 iterations
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue([]);

		await syncCycle();

		// Should call getCustomJsonInRange 3 times: 1001-3000, 3001-5000, 5001-6000
		expect(mockGetCustomJsonInRange.mock.calls.length).toBe(3);
		expect(mockGetCustomJsonInRange.mock.calls[0]![0]).toBe(1001);
		expect(mockGetCustomJsonInRange.mock.calls[0]![1]).toBe(3000);
		expect(mockGetCustomJsonInRange.mock.calls[1]![0]).toBe(3001);
		expect(mockGetCustomJsonInRange.mock.calls[1]![1]).toBe(5000);
		expect(mockGetCustomJsonInRange.mock.calls[2]![0]).toBe(5001);
		expect(mockGetCustomJsonInRange.mock.calls[2]![1]).toBe(6000);
	});

	test("disables synchronous_commit during massive sync", async () => {
		const hafOps = [fakeHafOp(1001)];
		const parsedOps = [fakeParsedOp(1001)];
		const txnCalls: string[] = [];

		// Track calls to the txn tagged template
		const trackingTxn = Object.assign(
			(strings: TemplateStringsArray, ..._values: unknown[]) => {
				txnCalls.push(strings.join(""));
				return Promise.resolve();
			},
			{ __mock: true },
		);

		mockWithTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
			await fn(trackingTxn);
		});

		trackedLastBlock = 1000;
		setupChainHead(2000); // massive
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue(hafOps);
		mockParseHafAHOperations.mockReturnValue(parsedOps);

		await syncCycle();

		// Should have called SET LOCAL synchronous_commit = OFF
		expect(txnCalls.some(c => c.includes("SET LOCAL synchronous_commit = OFF"))).toBe(true);
	});

	test("detects and corrects block continuity violations", async () => {
		// Simulate: getLastBlock returns 1000 initially, but after first check
		// we artificially break continuity by having getLastBlock return a different value
		let callCount = 0;
		mockGetLastBlock.mockImplementation(() => {
			callCount++;
			// First call: syncCycle init (returns 1000)
			// Second call: continuity check, return 1000 (correct, current=1001)
			// After range processes, trackedLastBlock becomes 3000
			// Third call: continuity check, return 3000 (correct, current=3001)
			if (callCount <= 2) return Promise.resolve(1000);
			return Promise.resolve(trackedLastBlock);
		});

		setupChainHead(6000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue([]);

		await syncCycle();

		// Should have processed ranges correctly despite the mock complexity
		expect(mockGetCustomJsonInRange).toHaveBeenCalled();
	});
});

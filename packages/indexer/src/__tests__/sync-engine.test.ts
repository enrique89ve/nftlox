import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { ParsedOperation, ParseResult } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";
import { ACTION_TRANSFER, ACTION_BUY, ACTION_NODE_REGISTER } from "@/protocol/index.ts";

type MockRouteOperationResult =
	| Readonly<{ readonly kind: "applied" }>
	| Readonly<{ readonly kind: "rejected"; readonly reason: string }>
	| Readonly<{ readonly kind: "fatal"; readonly reason: string }>;

function appliedRouteResult(): MockRouteOperationResult {
	return { kind: "applied" };
}

function rejectedRouteResult(reason: string): MockRouteOperationResult {
	return { kind: "rejected", reason };
}

function fatalRouteResult(reason: string): MockRouteOperationResult {
	return { kind: "fatal", reason };
}

// ─── Mocks ──────────────────────────────────────────

// Mock @/config.ts before any other import so transitive module loads never
// trigger the ACTIVE_KEY/POSTING_KEY validation at config.ts:105–116.
// The sync engine only needs genesisBlock, syncIntervalMs, and protocolId.
mock.module("@/config.ts", () => ({
	config: {
		genesisBlock: 105530500,
		syncIntervalMs: 3000,
		protocolId: "nftlox_testnet",
		logLevel: "info",
		hiveAccount: "gametest.ing",
		indexerRole: "sync",
		nodeRegister: false,
		batchSize: 1000,
		databaseUrl: "postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer",
		nodeEnv: "test",
		enableSwagger: false,
		healthPort: 0,
		nodeUrl: "",
		postgresPassword: "nftlox_dev",
		postgresUser: "nftlox",
		postgresDb: "nftlox_indexer",
		hiveEndpoints: ["https://api.syncad.com"],
		multisigRateLimitMax: 10,
		multisigRateLimitWindowMs: 60_000,
		multisigIpRateLimitMax: 30,
		multisigIpRateLimitWindowMs: 60_000,
		multisigPowBits: 10,
		multisigPowTtlMs: 300_000,
		multisigPowMaxFutureSkewMs: 30_000,
		multisigPowReplayCacheMax: 10_000,
	},
}));

// Shared state between getLastBlock/updateLastBlock so the continuity check works
let trackedLastBlock = 0;

const mockGetLastBlock = mock(() => Promise.resolve(trackedLastBlock));
const mockUpdateLastBlock = mock((block: number, _txn?: unknown) => {
	trackedLastBlock = block;
	return Promise.resolve();
});
const mockGetBlockchainHead = mock((_consistency?: "fast" | "strict") =>
	Promise.resolve({ headBlock: 0, irreversibleBlock: 0 }),
);
const mockGetCustomJsonInRange = mock(
	(_from: number, _to: number, _id: string, _behind?: number) => Promise.resolve([] as HafAHOperation[]),
);
const mockGetHafAHBlockRange = mock(() => 2000);
const mockGetTransfersInTransaction = mock((_txId: string) => Promise.resolve([] as Array<{
	from: string; to: string; amount: number; currency: string; memo: string;
}>));
const mockParseHafAHOperations = mock((_ops: HafAHOperation[]): ParseResult => ({ ops: [], rejected: [] }));
const mockRouteOperationDetailed = mock(
	(_op: ParsedOperation, _txn: unknown) => Promise.resolve(appliedRouteResult()),
);
const mockInsertInvalidOperation = mock(() => Promise.resolve());
const mockWithTransaction = mock(async (fn: (txn: unknown) => Promise<void>) => {
	await fn(mockTxn);
});
const mockLookupHiveAccounts = mock(async (accounts: readonly string[]) => ({
	requested: accounts,
	accounts: new Map(accounts.map((name) => [
		name,
		{ name, createdAt: "2020-01-01T00:00:00.000Z" },
	])),
	missing: new Set<string>(),
	attemptedEndpoints: ["mock"],
}));

// Returns a postgres.js-like Result: an Array with `.count` and `.command`.
// Every txn`...` call needs this shape so callers can read .count, destructure
// index 0, iterate, or spread — just as they would with a real postgres Result.
function makePgResult(rows: unknown[] = []): unknown[] & { count: number; command: string } {
	const result = rows.slice() as unknown[] & { count: number; command: string };
	result.count = rows.length;
	result.command = "SELECT";
	return result;
}

// Fake txn object that supports tagged template literals (for SET LOCAL,
// sweepExpiredBuyCommitments .count reads, updateLastBlock, and any other query
// that the sync engine runs inside withTransaction).
const mockTxn = Object.assign(
	(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(makePgResult()),
	{ __mock: true },
);

mock.module("@/db/queries/sync.ts", () => ({
	getLastBlock: mockGetLastBlock,
	updateLastBlock: mockUpdateLastBlock,
	updateHiveChainTip: mock(() => Promise.resolve()),
	cleanupExpiredOperations: mock(() => Promise.resolve(0)),
	insertInvalidOperation: mockInsertInvalidOperation,
	// Stubs keep the module's export shape complete so bun's process-wide
	// mock registry doesn't starve sibling test files (e.g. status-route.test.ts).
	getSyncStatus: mock(() => Promise.resolve({ lastBlock: 0, updatedAt: new Date() })),
	getOperationStatus: mock(() => Promise.resolve([])),
	getLastBlockForUpdate: mock(() => Promise.resolve(0)),
	isOperationConfirmed: mock(() => Promise.resolve(false)),
	insertConfirmedOperation: mock(() => Promise.resolve()),
	insertOrphanedBuy: mock(() => Promise.resolve()),
}));

// sync-lock lives in scanner/, not db/queries. Tests call syncCycle directly
// without starting syncLoop, so the real dedicated-connection path would fail.
// verifyLockHeld is mocked true so the per-batch fence treats the lock as held.
mock.module("@/scanner/sync-lock.ts", () => ({
	acquireSyncLock: mock(() => Promise.resolve({ status: "acquired" })),
	releaseSyncLock: mock(() => Promise.resolve()),
	verifyLockHeld: mock(() => Promise.resolve(true)),
	// The lock-lost path is not exercised here (verifyLockHeld is always true),
	// but the module mock must expose every export sync-engine.ts imports.
	syncLockLostError: mock((message: string) => new Error(message)),
	isSyncLockLostError: mock(() => false),
	// withSyncWriteTransaction delegates to the same withTransaction mock so
	// tests bypass the xact-level fence without duplicating transaction logic.
	withSyncWriteTransaction: mockWithTransaction,
}));

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockchainHead: mockGetBlockchainHead,
	getCustomJsonInRange: mockGetCustomJsonInRange,
	getHafAHBlockRange: mockGetHafAHBlockRange,
	getTransfersInTransaction: mockGetTransfersInTransaction,
	lookupHiveAccounts: mockLookupHiveAccounts,
	checkClockDrift: mock(() => Promise.resolve()),
	// Kept so chain-anchors mock shape stays complete across test files.
	getBlockIdFromAllEndpoints: mock((blockNum: number) =>
		Promise.resolve([{ endpoint: "mock", blockId: `block_${blockNum}` }]),
	),
}));

mock.module("@/scanner/operation-parser.ts", () => ({
	parseHafAHOperations: mockParseHafAHOperations,
}));

mock.module("@/processor/action-router.ts", () => ({
	routeOperationDetailed: mockRouteOperationDetailed,
	routeOperation: mock(() => Promise.resolve(true)),
}));

// state-root queries are exercised by sync-engine.ts at batch-end (flush +
// snapshot for the F3.A checkpoint emitter). The full DB layer never runs in
// these tests — the txn is a mock — so we stub the three call sites with
// no-op implementations that satisfy the real signatures. parseNftStateRow,
// queueStateRootDelta, etc. are kept as inert stubs because nft-mutations.ts
// imports them at module load even though no real path here invokes them.
mock.module("@/db/queries/state-root.ts", () => ({
	flushStateRootBuffer: mock(() => Promise.resolve()),
	getStateMeta: mock(() =>
		Promise.resolve({
			state_root: new Uint8Array(32),
			nft_count: 0,
			last_block_num: 0,
			updated_at: "1970-01-01T00:00:00.000Z",
		}),
	),
	recordCheckpointIfBoundary: mock(() => Promise.resolve()),
	parseNftStateRow: mock((row: unknown) => row),
	queueStateRootDelta: mock(() => undefined),
	bootstrapStateRootFromFullScan: mock(() =>
		Promise.resolve({
			state_root: new Uint8Array(32),
			nft_count: 0,
			last_block_num: 0,
			updated_at: "1970-01-01T00:00:00.000Z",
		}),
	),
	getFormattedStateRoot: mock(() =>
		Promise.resolve({
			state_root: `sha256:${"0".repeat(64)}`,
			nft_count: 0,
			last_block_num: 0,
			updated_at: "1970-01-01T00:00:00.000Z",
		}),
	),
	computeStateRootFullScan: mock(() => Promise.resolve(new Uint8Array(32))),
}));

// Minimal StateRootBuffer stub — only the fields that nft-mutations.ts and
// state-root.ts touch at runtime (all through the mock txn, which never
// reaches real DB code). Keeping it structurally complete avoids TS import
// errors from transitively-imported query modules.
const mockBuffer = {
	deltas: [] as unknown[],
	blockNum: 0,
};

mock.module("@/db/client.ts", () => ({
	withTransaction: mockWithTransaction,
	sql: Object.assign(
		(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
		{
			begin: (fn: (sql: unknown) => Promise<unknown>) => fn((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([])),
			end: () => Promise.resolve(),
			unsafe: (_query: string) => Promise.resolve([]),
			json: (v: unknown) => v,
		},
	),
	// Used by nft-mutations.ts and action-router.ts for state-root tracking.
	// The mock txn never triggers real flush paths, so returning the stub is safe.
	getStateRootBuffer: (_txn: unknown) => mockBuffer,
	getTxSavepointHandle: (_txn: unknown) => ({
		savepoint: (fn: (sp: unknown) => Promise<unknown>) => fn(mockTxn),
	}),
	attachScope: (queryable: unknown, _ctx: unknown) => queryable,
	// toJsonb is used by nft-mutations.ts and sync.ts — just pass through the value.
	toJsonb: (value: unknown) => value,
	clampLimit: (limit: number, defaultVal = 50) => {
		if (limit < 1 || !Number.isFinite(limit)) return defaultVal;
		return Math.min(limit, 1000);
	},
	testConnection: () => Promise.resolve(),
	closePool: () => Promise.resolve(),
}));

// Import AFTER mocks so they take effect
const { syncCycle, setRunning, resetHeadTracker } = await import("@/scanner/sync-engine.ts");
const { isSynced, setSynced, getSyncProgress, updateSyncProgress, setSyncReporter } = await import("@/scanner/sync-state.ts");

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
		timestamp: "2024-01-01T00:00:00.000Z",
		operation_id: `${block}`,
		virtual_op: false,
	};
}

function fakeParsedOp(block: number, action = ACTION_TRANSFER): ParsedOperation {
	return {
		blockNum: block,
		timestamp: "2024-01-01T00:00:00.000Z",
		txId: `tx_${block}`,
		operationId: `op_${block}`,
		signer: "alice",
		authLevel: action === ACTION_TRANSFER ? "active" : "posting",
		action: action as ParsedOperation["action"],
		version: "0.2.1",
		data: action === ACTION_TRANSFER ? { to: "bob" } : {},
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
	mockRouteOperationDetailed.mockReset();
	mockInsertInvalidOperation.mockReset();
	mockWithTransaction.mockReset();
	mockLookupHiveAccounts.mockReset();

	// Restore default implementations with shared state
	mockGetLastBlock.mockImplementation(() => Promise.resolve(trackedLastBlock));
	mockUpdateLastBlock.mockImplementation((block: number) => {
		trackedLastBlock = block;
		return Promise.resolve();
	});
	mockGetCustomJsonInRange.mockImplementation(() => Promise.resolve([]));
	mockGetHafAHBlockRange.mockImplementation(() => 2000);
	mockGetTransfersInTransaction.mockImplementation(() => Promise.resolve([]));
	mockParseHafAHOperations.mockImplementation(() => ({ ops: [], rejected: [] }));
	mockRouteOperationDetailed.mockImplementation(() => Promise.resolve(appliedRouteResult()));
	mockInsertInvalidOperation.mockImplementation(() => Promise.resolve());
	mockWithTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
		await fn(mockTxn);
	});
	mockLookupHiveAccounts.mockImplementation(async (accounts: readonly string[]) => ({
		requested: accounts,
		accounts: new Map(accounts.map((name) => [
			name,
			{ name, createdAt: "2020-01-01T00:00:00.000Z" },
		])),
		missing: new Set<string>(),
		attemptedEndpoints: ["mock"],
	}));

	// Reset sync state
	setSyncReporter({
		onProgress: () => {},
		onSyncedChange: () => {},
	});
	setSynced(false);
	updateSyncProgress({ lastBlock: 0, headBlock: 0, irreversibleBlock: 0 });
	setRunning(true);
	resetHeadTracker();
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
		// genesisBlock from config
		// First updateLastBlock call should be the genesis init
		expect(typeof firstCall![0]).toBe("number");
		expect(firstCall![0]).toBeGreaterThan(0);
	});

	test("processes remaining irreversible blocks even when only a few behind", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1005, 1010); // 5 blocks behind irreversible
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);

		await syncCycle();

		expect(mockGetCustomJsonInRange).toHaveBeenCalledTimes(1);
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
		mockParseHafAHOperations.mockReturnValue(wrapOps(parsedOps));

		await syncCycle();

		// Should parse the hafah ops
		expect(mockParseHafAHOperations).toHaveBeenCalledWith(hafOps);
		// Should process each op via routeOperation
		expect(mockRouteOperationDetailed).toHaveBeenCalledTimes(2);
		// Should run inside a transaction
		expect(mockWithTransaction).toHaveBeenCalled();
	});

	test("rejects only operations whose explicit Hive recipient is missing", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		const valid = fakeParsedOp(1001);
		const missing = {
			...fakeParsedOp(1002),
			data: { to: "missing-account" },
		};
		mockParseHafAHOperations.mockReturnValue(wrapOps([valid, missing]));
		mockLookupHiveAccounts.mockResolvedValue({
			requested: ["bob", "missing-account"],
			accounts: new Map([
				["bob", { name: "bob", createdAt: "2020-01-01T00:00:00.000Z" }],
			]),
			missing: new Set(["missing-account"]),
			attemptedEndpoints: ["mock"],
		});

		await syncCycle();

		expect(mockLookupHiveAccounts).toHaveBeenCalledWith(["bob", "missing-account"]);
		expect(mockRouteOperationDetailed).toHaveBeenCalledTimes(1);
		expect(mockRouteOperationDetailed).toHaveBeenCalledWith(valid, expect.anything());
		expect(mockInsertInvalidOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				operationId: missing.operationId,
				action: ACTION_TRANSFER,
				reason: "Hive account does not exist: missing-account",
			}),
			expect.anything(),
		);
	});

	test("rejects an account created after the operation without blocking cursor advancement", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		const op = fakeParsedOp(1001);
		mockParseHafAHOperations.mockReturnValue(wrapOps([op]));
		mockLookupHiveAccounts.mockResolvedValue({
			requested: ["bob"],
			accounts: new Map([
				["bob", { name: "bob", createdAt: "2025-01-01T00:00:00.000Z" }],
			]),
			missing: new Set<string>(),
			attemptedEndpoints: ["mock"],
		});

		await syncCycle();

		expect(mockRouteOperationDetailed).not.toHaveBeenCalled();
		expect(mockInsertInvalidOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				operationId: op.operationId,
				reason: expect.stringContaining("did not exist before operation timestamp"),
			}),
			expect.anything(),
		);
		expect(trackedLastBlock).toBe(1001);
	});

	test("rejects an empty transfer recipient without an account RPC call", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		const invalid = { ...fakeParsedOp(1001), data: { to: "" } };
		mockParseHafAHOperations.mockReturnValue(wrapOps([invalid]));

		await syncCycle();

		expect(mockLookupHiveAccounts).not.toHaveBeenCalled();
		expect(mockRouteOperationDetailed).not.toHaveBeenCalled();
		expect(mockInsertInvalidOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				operationId: invalid.operationId,
				reason: expect.stringContaining("to"),
			}),
			expect.anything(),
		);
	});

	test("does not open a DB transaction when account lookup is unavailable", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([fakeParsedOp(1001)]));
		mockLookupHiveAccounts.mockRejectedValue(new Error("Hive RPC unavailable"));

		await expect(syncCycle()).rejects.toThrow("Hive RPC unavailable");

		expect(mockWithTransaction).not.toHaveBeenCalled();
		expect(trackedLastBlock).toBe(1000);
	});

	test("does not advance the DB cursor when a HafAH range fails", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockRejectedValue(new Error("HafAH range failed"));

		await expect(syncCycle()).rejects.toThrow("HafAH range failed");

		expect(mockWithTransaction).not.toHaveBeenCalled();
		expect(trackedLastBlock).toBe(1000);
	});

	test("advances cursor inside the shared materializer tx when no ops", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		// Should still advance the cursor
		expect(mockUpdateLastBlock).toHaveBeenCalled();
		expect(mockWithTransaction).toHaveBeenCalled();
		expect(mockRouteOperationDetailed).not.toHaveBeenCalled();
		expect(mockInsertInvalidOperation).not.toHaveBeenCalled();
	});

	test("persists parser-rejected operations into invalid_operations before routing", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue({
			ops: [fakeParsedOp(1001)],
			rejected: [{
				blockNum: 1001,
				txId: "tx_rejected",
				operationId: "op_rejected",
				signer: "alice",
				reason: "Missing or invalid data field",
				rawPayload: {
					protocol: "nftlox_testnet",
					version: "0.2.1",
					action: ACTION_TRANSFER,
					data: null,
				},
			}],
		});

		await syncCycle();

		expect(mockInsertInvalidOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				blockNum: 1001,
				txId: "tx_rejected",
				operationId: "op_rejected",
				signer: "alice",
				action: null,
				reason: "Missing or invalid data field",
			}),
			expect.anything(),
		);
		expect(mockRouteOperationDetailed).toHaveBeenCalledTimes(1);
	});

	test("toggles synced around non-massive catch-up in the same cycle", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1050); // 50 behind (< massive)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		setSynced(true);

		const transitions: boolean[] = [];
		setSyncReporter({
			onProgress: () => {},
			onSyncedChange: (value) => {
				transitions.push(value);
			},
		});

		await syncCycle();

		expect(transitions).toEqual([false, true]);
		expect(isSynced()).toBe(true);
	});

	test("sets synced=false during massive sync", async () => {
		trackedLastBlock = 1000;
		setupChainHead(2000); // 1000 behind (> MASSIVE_THRESHOLD=100)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		setSynced(true); // pre-set to true
		await syncCycle();

		// Massive sync sets synced=false then back to true on completion
		expect(isSynced()).toBe(true);
	});

	test("enriches buy ops with paired transfers", async () => {
		const hafOps = [fakeHafOp(1001)];
		const buyOp = fakeParsedOp(1001, ACTION_BUY);

		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue(hafOps);
		mockParseHafAHOperations.mockReturnValue(wrapOps([buyOp]));
		mockGetTransfersInTransaction.mockResolvedValue([]);

		await syncCycle();

		expect(mockGetTransfersInTransaction).toHaveBeenCalledWith("tx_1001");
	});

	test("updates sync progress after each range", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1020);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		const progress = getSyncProgress();
		// Should have updated progress to the range end
		expect(progress.lastBlock).toBeGreaterThanOrEqual(1020);
		expect(progress.headBlock).toBe(1020);
		expect(progress.irreversibleBlock).toBe(1020);
	});

	test("always fetches chain head via strict multi-endpoint consensus", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1050, 1065);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		// Single strict-consensus call — no fast-path shortcut, even near live.
		// The previous two-step (fast → maybe strict) pattern let one endpoint
		// dictate the irreversible frontier during massive sync.
		expect(mockGetBlockchainHead.mock.calls).toHaveLength(1);
		expect(mockGetBlockchainHead.mock.calls[0]).toEqual([]);
	});

	test("uses strict consensus even during massive sync (no fast shortcut)", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000);
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		expect(mockGetBlockchainHead.mock.calls).toHaveLength(1);
		expect(mockGetBlockchainHead.mock.calls[0]).toEqual([]);
	});

	test("processes multiple ranges with parallel fetch during massive sync", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000); // 5000 behind (massive), blockRange=2000
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		// Parallel: iter1 fetches 1001-3000 + 3001-5000, iter2 fetches 5001-6000
		// Total: 3 calls to getCustomJsonInRange
		const calls = mockGetCustomJsonInRange.mock.calls;
		expect(calls.length).toBe(3);
		expect(calls[0]![0]).toBe(1001);
		expect(calls[0]![1]).toBe(3000);
		expect(calls[1]![0]).toBe(3001);
		expect(calls[1]![1]).toBe(5000);
		expect(calls[2]![0]).toBe(5001);
		expect(calls[2]![1]).toBe(6000);
	});

	test("parallel fetch: range 2 failure falls back to range 1 only", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000); // massive
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		let callCount = 0;
		mockGetCustomJsonInRange.mockImplementation(() => {
			callCount++;
			// Fail every second call (range 2 in each parallel pair)
			if (callCount % 2 === 0) return Promise.reject(new Error("endpoint down"));
			return Promise.resolve([]);
		});

		await syncCycle();

		// Range 2 fails each time → processes only range 1 per iteration
		// 5000 blocks / 2000 per range = ~3 single-range iterations (with retries of range 2)
		expect(trackedLastBlock).toBe(6000);
	});

	test("no parallel fetch when not in massive sync", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1050); // 50 behind (< MASSIVE_THRESHOLD=100)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		// Only 1 call — no parallel fetch for non-massive sync
		expect(mockGetCustomJsonInRange.mock.calls.length).toBe(1);
		// No endpointOffset argument (default 0)
	});

	test("rejected operations continue syncing and advance the cursor", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000); // massive
		mockGetHafAHBlockRange.mockReturnValue(2000);

		const failingOps = Array.from({ length: 12 }, (_, i) => fakeParsedOp(1001 + i));
		let parseCall = 0;

		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockImplementation(() => {
			const suffix = parseCall++;
			return wrapOps(failingOps.map((op) => ({
				...op,
				operationId: `${op.operationId}_${suffix}`,
			})));
		});
		mockRouteOperationDetailed.mockResolvedValue(rejectedRouteResult("invalid payload"));

		await syncCycle();

		expect(trackedLastBlock).toBe(6000);
	});

	test("fatal route failure aborts the batch without advancing cursor", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetHafAHBlockRange.mockReturnValue(2000);

		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([fakeParsedOp(1001)]));
		mockRouteOperationDetailed.mockResolvedValue(fatalRouteResult("db write failed"));

		await expect(syncCycle()).rejects.toThrow("Fatal route failure");
		expect(trackedLastBlock).toBe(1000);
	});

	test("keeps durable commits during massive sync", async () => {
		const hafOps = [fakeHafOp(1001)];
		const parsedOps = [fakeParsedOp(1001)];
		const txnCalls: string[] = [];

		// Track calls to the txn tagged template
		const trackingTxn = Object.assign(
			(strings: TemplateStringsArray, ..._values: unknown[]) => {
				txnCalls.push(strings.join(""));
				return Promise.resolve(makePgResult());
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
		mockParseHafAHOperations.mockReturnValue(wrapOps(parsedOps));

		await syncCycle();

		expect(txnCalls.some(c => c.includes("SET LOCAL synchronous_commit"))).toBe(false);
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
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		// Should have processed ranges correctly despite the mock complexity
		expect(mockGetCustomJsonInRange).toHaveBeenCalled();
	});

	// ─── block skipping / filtering ───────────────────

	test("skips blocks with no protocol ops — cursor advances, no routeOperation", async () => {
		trackedLastBlock = 1000;
		setupChainHead(3000); // 2000 behind (massive)
		mockGetHafAHBlockRange.mockReturnValue(2000);

		// HafAH returns custom_json ops but parser says none are ours
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1500), fakeHafOp(2000)]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([])); // no protocol ops

		await syncCycle();

		// Cursor advanced to 3000
		expect(trackedLastBlock).toBe(3000);
		// No ops processed
		expect(mockRouteOperationDetailed).not.toHaveBeenCalled();
		expect(mockInsertInvalidOperation).not.toHaveBeenCalled();
		// Per-cycle transaction still opens for the unlist materializer + cursor
		// update, even when zero protocol ops landed in the range.
		expect(mockWithTransaction).toHaveBeenCalled();
	});

	test("processes only protocol ops when mixed with foreign custom_json", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1020); // 20 behind (not massive)
		mockGetHafAHBlockRange.mockReturnValue(2000);

		// HafAH returns 3 ops but only 1 is ours
		const foreignOps = [fakeHafOp(1005), fakeHafOp(1010), fakeHafOp(1015)];
		const onlyOurs = [fakeParsedOp(1010)];

		mockGetCustomJsonInRange.mockResolvedValue(foreignOps);
		mockParseHafAHOperations.mockReturnValue(wrapOps(onlyOurs));

		await syncCycle();

		// Only 1 op routed (the protocol one), not 3
		expect(mockRouteOperationDetailed).toHaveBeenCalledTimes(1);
		expect(trackedLastBlock).toBe(1020);
	});

	test("parallel fetch: empty batch 1 + ops in batch 2 — both advance cursor", async () => {
		trackedLastBlock = 1000;
		setupChainHead(6000); // massive
		mockGetHafAHBlockRange.mockReturnValue(2000);

		let fetchCount = 0;
		mockGetCustomJsonInRange.mockImplementation(() => {
			fetchCount++;
			// Batch 2 (second call) has ops, batch 1 (first call) is empty
			if (fetchCount === 2) return Promise.resolve([fakeHafOp(3500)]);
			return Promise.resolve([]);
		});

		mockParseHafAHOperations.mockImplementation((ops: any) => {
			if (ops.length > 0) return wrapOps([fakeParsedOp(3500)]);
			return wrapOps([]);
		});

		await syncCycle();

		// Ops from batch 2 were processed
		expect(mockRouteOperationDetailed).toHaveBeenCalled();
		// Cursor advanced past both batches
		expect(trackedLastBlock).toBe(6000);
	});

	test("does NOT enrich node_register with same-tx transfers (fee-less)", async () => {
		trackedLastBlock = 1000;
		setupChainHead(1001);
		mockGetCustomJsonInRange.mockResolvedValue([fakeHafOp(1001)]);
		const nodeRegisterOp = fakeParsedOp(1001, ACTION_NODE_REGISTER);
		mockParseHafAHOperations.mockReturnValue(wrapOps([nodeRegisterOp]));

		await syncCycle();

		// node_register is NOT in transferBackedOps → no transfer RPC for its txId.
		expect(mockGetTransfersInTransaction).not.toHaveBeenCalledWith("tx_1001");
		expect(mockRouteOperationDetailed).toHaveBeenCalledWith(
			expect.objectContaining({ action: ACTION_NODE_REGISTER }),
			expect.anything(),
		);
	});

	test("1000 empty blocks advance cursor without processing", async () => {
		trackedLastBlock = 50000;
		setupChainHead(51000); // 1000 behind (massive)
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockResolvedValue([]);
		mockParseHafAHOperations.mockReturnValue(wrapOps([]));

		await syncCycle();

		// Cursor advanced fully
		expect(trackedLastBlock).toBe(51000);
		// Zero ops processed
		expect(mockRouteOperationDetailed).not.toHaveBeenCalled();
		// A transaction is opened per batch cycle to wrap the cursor update and
		// the materializer sweep — empty-batch cycles still need it.
		expect(mockWithTransaction).toHaveBeenCalled();
	});
});

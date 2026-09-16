import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { sql, withTransaction, type Queryable } from "@/db/client.ts";
import { config } from "@/config.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import type { ParsedOperation, ParseResult } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	getAuthLevel,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateOriginDna,
} from "@/protocol/index.ts";

const BEFORE_BLOCK = 90_000_100;
const BATCH_BLOCK = BEFORE_BLOCK + 1;
const COLLECTION_NAME = "SyncCycleRecovery";
const COLLECTION_SYMBOL = "SYNCREC";
const ART_A = "sync-cycle-a";
const ART_B = "sync-cycle-b";

let collectionId: string;
let seedA: string;
let seedB: string;
let parsedOps: ParsedOperation[] = [];

function makeOp(
	action: string,
	data: Record<string, unknown>,
	overrides: Partial<Pick<ParsedOperation, "operationId" | "txId" | "signer" | "blockNum">> = {},
): ParsedOperation {
	return {
		blockNum: overrides.blockNum ?? BATCH_BLOCK,
		timestamp: "2025-01-01T00:00:00.000Z",
		version: PROTOCOL_VERSION,
		txId: overrides.txId ?? `sync-cycle-${action}`,
		operationId: overrides.operationId ?? `op-sync-cycle-${action}`,
		signer: overrides.signer ?? "alice",
		authLevel: getAuthLevel(action),
		action: action as ParsedOperation["action"],
		data,
	};
}

function makeParseResult(): ParseResult {
	return { ops: parsedOps, rejected: [] };
}

// syncCycle remains real; only its external read-only Hive inputs and its HA
// lock wrapper are replaced with deterministic fixtures. The writer transaction,
// router, savepoints, triggers, state-root flush, and cursor update are real.
const mockGetBlockchainHead = mock(() => Promise.resolve({
	headBlock: BATCH_BLOCK,
	irreversibleBlock: BATCH_BLOCK,
	headTime: "2025-01-01T00:00:00.000Z",
}));
const mockGetCustomJsonInRange = mock((_from: number, _to: number, _id: string, _behind?: number) =>
	Promise.resolve([] as HafAHOperation[]));
const mockGetHafAHBlockRange = mock(() => 1000);
const mockGetTransfersInTransaction = mock((_txId: string) => Promise.resolve([]));
const mockLookupHiveAccounts = mock(async (accounts: readonly string[]) => ({
	requested: accounts,
	accounts: new Map(accounts.map((name) => [name, {
		name,
		createdAt: "2020-01-01T00:00:00.000Z",
	}])),
	missing: new Set<string>(),
	attemptedEndpoints: ["deterministic-test-fixture"],
}));

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockchainHead: mockGetBlockchainHead,
	getCustomJsonInRange: mockGetCustomJsonInRange,
	getHafAHBlockRange: mockGetHafAHBlockRange,
	getTransfersInTransaction: mockGetTransfersInTransaction,
	lookupHiveAccounts: mockLookupHiveAccounts,
	checkClockDrift: mock(() => Promise.resolve({ ok: true, driftMs: 0 })),
	getBlockIdFromAllEndpoints: mock(() => Promise.resolve([])),
}));

mock.module("@/scanner/operation-parser.ts", () => ({
	parseHafAHOperations: mock((_rows: HafAHOperation[]) => makeParseResult()),
}));

mock.module("@/scanner/sync-lock.ts", () => ({
	acquireSyncLock: mock(() => Promise.resolve({ status: "acquired" })),
	releaseSyncLock: mock(() => Promise.resolve()),
	verifyLockHeld: mock(() => Promise.resolve(true)),
	syncLockLostError: mock((message: string) => new Error(message)),
	isSyncLockLostError: mock(() => false),
	withSyncWriteTransaction: async <T>(fn: (txn: Queryable) => Promise<T>): Promise<T> =>
		withTransaction(async (txn) => {
			await txn`SET LOCAL lock_timeout = '50ms'`;
			return fn(txn);
		}),
}));

const { syncCycle, resetHeadTracker, setRunning } = await import("@/scanner/sync-engine.ts");

async function cleanDb(): Promise<void> {
	await sql`TRUNCATE assets, owner_asset_counts, collection_stats, collections,
		invalid_operations, confirmed_operations, orphaned_buys RESTART IDENTITY CASCADE`;
	await sql`
		UPDATE state_meta
		SET state_root = decode(${"0".repeat(64)}, 'hex'), asset_count = 0, last_block_num = 0
		WHERE id = 1
	`;
	await sql`
		UPDATE sync_state
		SET last_block = ${BEFORE_BLOCK}, hive_head_block = 0,
			hive_irreversible_block = 0, hive_head_time = NULL
		WHERE id = 1
	`;
}

async function seedFixture(): Promise<void> {
	const createOp = makeOp(ACTION_CREATE_COLLECTION, {
		id: collectionId,
		name: COLLECTION_NAME,
		symbol: COLLECTION_SYMBOL,
		originDna: await generateOriginDna(collectionId),
		totalPotential: 10,
		maxInstances: 0,
		metadata: { description: "sync cycle recovery test", image: "https://example.com/sync-cycle.png" },
		rules: { transferable: true, burnable: false, royaltyPct: 0 },
	}, { signer: config.hiveAccount, operationId: "op-sync-cycle-create" });
	const feeAmount = Number(PROTOCOL_COLLECTION_FEE_HBD);
	createOp.pairedTransfers = [{
		from: "alice",
		to: config.hiveAccount,
		amount: feeAmount,
		currency: "HBD",
		memo: `NFTLox FEE-COL:${collectionId}`,
	}];
	createOp.payment = {
		kind: "fixed",
		payer: "alice",
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};

	await withTransaction(async (txn) => {
		await handleCreateCollection(createOp, txn);
		for (const [artId, id, operationId] of [
			[ART_A, seedA, "op-sync-cycle-mint-a"],
			[ART_B, seedB, "op-sync-cycle-mint-b"],
		] as const) {
			await handleMint(makeOp(ACTION_MINT, {
				id,
				artId,
				collectionId,
				edition: 1,
				owner: "alice",
				assetType: "seed",
				maxSupply: 1,
			}, { operationId }), txn);
		}
	});

	// The first valid transfer deletes this approval. Its presence makes the
	// rollback assertion cover ownership, counters, and allowance state.
	await sql`
		INSERT INTO asset_allowances (asset_id, owner, approved_spender, block_num, tx_id)
		VALUES (${seedA}, 'alice', 'approved.spender', ${BEFORE_BLOCK}, ${"c".repeat(40)})
	`;
}

describe("syncCycle real PostgreSQL recovery", () => {
	beforeEach(async () => {
		collectionId = await generateDeterministicCollectionId("alice", COLLECTION_NAME, COLLECTION_SYMBOL);
		seedA = await generateDeterministicSeedId(collectionId, ART_A);
		seedB = await generateDeterministicSeedId(collectionId, ART_B);
		parsedOps = [
			makeOp(ACTION_TRANSFER, { assetId: seedA, to: "bob" }, {
				operationId: "op-sync-cycle-transfer-a",
				txId: "a".repeat(40),
			}),
			makeOp(ACTION_TRANSFER, { assetId: seedB, to: "bob" }, {
				operationId: "op-sync-cycle-transfer-b",
				txId: "b".repeat(40),
			}),
		];
		resetHeadTracker();
		setRunning(true);
		await cleanDb();
		await seedFixture();
	});

	afterEach(cleanDb);

	it("aborts the real sync batch on timeout, then retries from the unchanged cursor", async () => {
		const before = {
			root: (await sql`SELECT state_root FROM state_meta WHERE id = 1`)[0]!.state_root,
			owners: [...await sql`SELECT id, owner FROM assets WHERE id IN (${seedA}, ${seedB}) ORDER BY id`],
			ownerCounts: [...await sql`SELECT owner, total, seeds, instances FROM owner_asset_counts ORDER BY owner`],
			collectionStats: [...await sql`SELECT collection_id, total, seeds, instances, listed, burned FROM collection_stats`],
			allowances: [...await sql`SELECT asset_id, owner, approved_spender FROM asset_allowances`],
		};

		let unlock!: () => void;
		let signalLocked!: () => void;
		const release = new Promise<void>((resolve) => { unlock = resolve; });
		const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
		const lockerPromise = sql.begin(async (rawTxn) => {
			const txn = rawTxn as unknown as typeof sql;
			await txn`SELECT id FROM assets WHERE id = ${seedB} FOR UPDATE`;
			signalLocked();
			await release;
		});

		try {
			await locked;
			await expect(syncCycle()).rejects.toThrow(/Fatal route failure/);

			expect(Number((await sql`SELECT last_block FROM sync_state WHERE id = 1`)[0]!.last_block)).toBe(BEFORE_BLOCK);
			expect((await sql`SELECT state_root FROM state_meta WHERE id = 1`)[0]!.state_root).toEqual(before.root);
			expect([...await sql`SELECT id, owner FROM assets WHERE id IN (${seedA}, ${seedB}) ORDER BY id`]).toEqual(before.owners);
			expect([...await sql`SELECT owner, total, seeds, instances FROM owner_asset_counts ORDER BY owner`]).toEqual(before.ownerCounts);
			expect([...await sql`SELECT collection_id, total, seeds, instances, listed, burned FROM collection_stats`]).toEqual(before.collectionStats);
			expect([...await sql`SELECT asset_id, owner, approved_spender FROM asset_allowances`]).toEqual(before.allowances);
			expect([...await sql`SELECT operation_id FROM confirmed_operations WHERE operation_id LIKE 'op-sync-cycle-%'`]).toHaveLength(0);
			expect([...await sql`SELECT operation_id FROM invalid_operations WHERE operation_id LIKE 'op-sync-cycle-%'`]).toHaveLength(0);

			unlock();
			await lockerPromise;
			await syncCycle();

			expect(Number((await sql`SELECT last_block FROM sync_state WHERE id = 1`)[0]!.last_block)).toBe(BATCH_BLOCK);
			expect([...await sql`SELECT owner FROM assets WHERE id IN (${seedA}, ${seedB}) ORDER BY id`]).toEqual([{ owner: "bob" }, { owner: "bob" }]);
			expect([...await sql`SELECT asset_id FROM asset_allowances WHERE asset_id = ${seedA}`]).toHaveLength(0);
			expect([...await sql`SELECT operation_id FROM confirmed_operations WHERE operation_id IN ('op-sync-cycle-transfer-a', 'op-sync-cycle-transfer-b') ORDER BY operation_id`]).toEqual([
				{ operation_id: "op-sync-cycle-transfer-a" },
				{ operation_id: "op-sync-cycle-transfer-b" },
			]);
		} finally {
			unlock();
			await lockerPromise;
		}
	});
});

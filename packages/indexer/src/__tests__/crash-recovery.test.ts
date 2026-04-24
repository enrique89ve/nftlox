import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withTransaction, sql } from "@/db/client.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateOriginDna,
	PROTOCOL_COLLECTION_FEE_HBD,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";
import { makeOp as _makeOp } from "./helpers/make-op.ts";

const COL_NAME = "CrashTest";
const COL_SYMBOL = "CRASH";
let COL_ID: string;

async function canonicalSeedId(artId: string, collectionId: string): Promise<string> {
	return generateDeterministicSeedId(collectionId, artId);
}

function makeOp(
	action: string,
	data: Record<string, unknown>,
	overrides: {
		signer?: string;
		txId?: string;
		operationId?: string;
		blockNum?: number;
		pairedTransfers?: ParsedOperation["pairedTransfers"];
	} = {},
): ParsedOperation {
	const op = _makeOp({
		action,
		data,
		signer: overrides.signer,
		blockNum: overrides.blockNum,
		txId: overrides.txId,
		pairedTransfers: overrides.pairedTransfers,
	});
	if (overrides.operationId) {
		return { ...op, operationId: overrides.operationId };
	}
	return op;
}

async function makeCreateCollectionOp(
	data: Record<string, unknown>,
	creator = "alice",
	overrides: { txId?: string; operationId?: string; blockNum?: number } = {},
): Promise<ParsedOperation> {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const memo = `NFTLox FEE-COL:${String(data.id)}`;
	const defaultOriginDna = await generateOriginDna(String(data.id));
	const dataWithDefaults = { maxInstances: 0, originDna: defaultOriginDna, ...data };
	const op = makeOp(ACTION_CREATE_COLLECTION, dataWithDefaults, {
		...overrides,
		signer: config.hiveAccount,
		pairedTransfers: [
			{ from: creator, to: config.hiveAccount, amount: feeAmount, currency: "HBD", memo },
		],
	});
	op.payment = {
		kind: "fixed",
		payer: creator,
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};
	return op;
}

async function cleanDb() {
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
}

describe("crash recovery", () => {
	beforeEach(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", COL_NAME, COL_SYMBOL);
		await cleanDb();
	});
	afterEach(cleanDb);

	it("idempotency gate prevents duplicate confirmed_operations on replay", async () => {
		// Scenario: Crash during sync cycle
		// Before crash: some ops were processed and recorded in confirmed_operations
		// After crash: sync cycle replays the same block range
		// Verification: idempotency gate (isOperationConfirmed) detects already-confirmed
		// ops and skips handler dispatch, preventing duplicate rows

		const seedId = await canonicalSeedId("crash-recovery-1", COL_ID);

		// Setup: Create collection and mint NFT (direct handlers, not via router)
		await withTransaction(async (txn) => {
			const createOp = await makeCreateCollectionOp(
				{
					id: COL_ID,
					name: COL_NAME,
					symbol: COL_SYMBOL,
					totalPotential: 100,
					metadata: { description: "Crash test", image: "https://example.com/crash.png" },
					rules: { transferable: true, burnable: false, royaltyPct: 0 },
				},
				"alice",
			);
			await handleCreateCollection(createOp, txn);

			const mintOp = makeOp(
				ACTION_MINT,
				{
					id: seedId,
					artId: "crash-recovery-1",
					collectionId: COL_ID,
					edition: 1,
					owner: "alice",
					nftType: "seed",
					maxSupply: 5,
				},
				{ signer: "alice" },
			);
			await handleMint(mintOp, txn);
		});

		// Verify NFT created
		const nftBefore = await sql`SELECT owner FROM nfts WHERE id = ${seedId}`;
		expect(nftBefore).toHaveLength(1);
		expect(nftBefore[0]?.owner).toBe("alice");

		// First transfer: alice -> bob (via routeOperation)
		const transferOp1 = makeOp(
			ACTION_TRANSFER,
			{ nftId: seedId, to: "bob" },
			{ signer: "alice", operationId: "crash-transfer-1" },
		);

		const result1 = await withTransaction(async (txn) => {
			return await routeOperation(transferOp1, txn);
		});
		expect(result1).toBe(true);

		// Verify transfer was recorded in confirmed_operations
		const afterFirst = await sql`
			SELECT COUNT(*) as cnt FROM confirmed_operations
			WHERE operation_id = 'crash-transfer-1'
		`;
		expect(Number(afterFirst[0]?.cnt)).toBe(1);

		// Verify ownership changed
		const nftAfterTransfer = await sql`SELECT owner FROM nfts WHERE id = ${seedId}`;
		expect(nftAfterTransfer[0]?.owner).toBe("bob");

		// CRASH RECOVERY SCENARIO: replay the same transfer
		// Idempotency gate should detect it's already confirmed and skip execution
		const result2 = await withTransaction(async (txn) => {
			return await routeOperation(transferOp1, txn);
		});
		expect(result2).toBe(true); // Still true (gate returns true), but no duplicate

		// Verify: NO DUPLICATE in confirmed_operations
		const afterSecond = await sql`
			SELECT COUNT(*) as cnt FROM confirmed_operations
			WHERE operation_id = 'crash-transfer-1'
		`;
		expect(Number(afterSecond[0]?.cnt)).toBe(1); // Still 1, not 2 — no duplicate!

		// Verify ownership is still bob (not transferred again)
		const nftFinal = await sql`SELECT owner FROM nfts WHERE id = ${seedId}`;
		expect(nftFinal[0]?.owner).toBe("bob");
	});

	it("multiple transfers in batch are safe with crash recovery", async () => {
		// Scenario: 3 transfers in a batch, crash before last_block advance
		// Next cycle: batch is replayed, idempotency gate prevents duplication

		const seedA = await canonicalSeedId("crash-batch-1a", COL_ID);
		const seedB = await canonicalSeedId("crash-batch-1b", COL_ID);
		const seedC = await canonicalSeedId("crash-batch-1c", COL_ID);

		// Setup
		await withTransaction(async (txn) => {
			const createOp = await makeCreateCollectionOp(
				{
					id: COL_ID,
					name: COL_NAME,
					symbol: COL_SYMBOL,
					totalPotential: 100,
					metadata: { description: "Batch test", image: "https://example.com/batch.png" },
					rules: { transferable: true, burnable: false, royaltyPct: 0 },
				},
				"alice",
			);
			await handleCreateCollection(createOp, txn);

			for (const [id, artId, owner] of [
				[seedA, "crash-batch-1a", "alice"],
				[seedB, "crash-batch-1b", "bob"],
				[seedC, "crash-batch-1c", "charlie"],
			]) {
				const mintOp = makeOp(
					ACTION_MINT,
					{
						id,
						artId,
						collectionId: COL_ID,
						edition: 1,
						owner,
						nftType: "seed",
						maxSupply: 5,
					},
					{ signer: "alice" },
				);
				await handleMint(mintOp, txn);
			}
		});

		// Batch of 3 transfers
		const transfers = [
			makeOp(
				ACTION_TRANSFER,
				{ nftId: seedA, to: "eve" },
				{ signer: "alice", operationId: "crash-batch-xfer-1" },
			),
			makeOp(
				ACTION_TRANSFER,
				{ nftId: seedB, to: "eve" },
				{ signer: "bob", operationId: "crash-batch-xfer-2" },
			),
			makeOp(
				ACTION_TRANSFER,
				{ nftId: seedC, to: "eve" },
				{ signer: "charlie", operationId: "crash-batch-xfer-3" },
			),
		];

		// First execution: all 3 transfers succeed
		await withTransaction(async (txn) => {
			for (const op of transfers) {
				const result = await routeOperation(op, txn);
				expect(result).toBe(true);
			}
		});

		// Verify all 3 recorded
		const afterBatch = await sql`
			SELECT COUNT(*) as cnt FROM confirmed_operations
			WHERE operation_id LIKE 'crash-batch-xfer-%'
		`;
		expect(Number(afterBatch[0]?.cnt)).toBe(3);

		// CRASH RECOVERY: replay same batch
		await withTransaction(async (txn) => {
			for (const op of transfers) {
				const result = await routeOperation(op, txn);
				expect(result).toBe(true);
			}
		});

		// Verify: still only 3, no duplicates
		const afterReplay = await sql`
			SELECT COUNT(*) as cnt FROM confirmed_operations
			WHERE operation_id LIKE 'crash-batch-xfer-%'
		`;
		expect(Number(afterReplay[0]?.cnt)).toBe(3); // No duplicates!

		// Verify ownerships are correct (each transferred once)
		const nftA = await sql`SELECT owner FROM nfts WHERE id = ${seedA}`;
		expect(nftA[0]?.owner).toBe("eve");

		const nftB = await sql`SELECT owner FROM nfts WHERE id = ${seedB}`;
		expect(nftB[0]?.owner).toBe("eve");

		const nftC = await sql`SELECT owner FROM nfts WHERE id = ${seedC}`;
		expect(nftC[0]?.owner).toBe("eve");
	});
});

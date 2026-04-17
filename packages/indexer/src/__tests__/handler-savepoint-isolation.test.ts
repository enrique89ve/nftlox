import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withTransaction, sql } from "@/db/client.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	PROTOCOL_COLLECTION_FEE_HBD,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";

const COL_NAME = "SavepointTest";
const COL_SYMBOL = "SPISOTEST";
const ART_ID_A = "art-sp-iso-a";
const ART_ID_B = "art-sp-iso-b";

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
	const signer = overrides.signer ?? "alice";
	const authLevelMap: Record<string, "posting" | "active"> = {
		[ACTION_CREATE_COLLECTION]: "active",
		[ACTION_MINT]: "active",
	};
	return {
		blockNum: overrides.blockNum ?? 1,
		timestamp: new Date(),
		txId: overrides.txId ?? `tx_sp_iso_${Date.now()}_${Math.random()}`,
		operationId: overrides.operationId ?? `op_sp_iso_${Date.now()}_${Math.random()}`,
		signer,
		authLevel: authLevelMap[action] ?? "posting",
		action: action as ParsedOperation["action"],
		data,
		pairedTransfers: overrides.pairedTransfers,
	};
}

function makeCreateCollectionOp(
	data: Record<string, unknown>,
	creator = "alice",
	overrides: { txId?: string; operationId?: string; blockNum?: number } = {},
): ParsedOperation {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	return makeOp(ACTION_CREATE_COLLECTION, data, {
		...overrides,
		signer: config.hiveAccount,
		pairedTransfers: [
			{ from: creator, to: config.hiveAccount, amount: feeAmount, currency: "HBD", memo: "" },
		],
	});
}

async function cleanDb() {
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
}

describe("handler savepoint isolation", () => {
	beforeEach(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", COL_NAME, COL_SYMBOL);
		await cleanDb();
	});
	afterEach(cleanDb);

	it("should revert database mutations when handler fails mid-execution", async () => {
		// Setup: Create collection, mint NFT for alice, then delete alice's counter
		// to force the transfer handler to fail in adjustOwnerNftCount()
		const seedIdA = await canonicalSeedId(ART_ID_A, COL_ID);

		await withTransaction(async (txn) => {
			const createOp = makeCreateCollectionOp({
				id: COL_ID,
				name: COL_NAME,
				symbol: COL_SYMBOL,
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/test.png" },
				rules: { transferable: true, burnable: false, royaltyPct: 0 },
			});
			await handleCreateCollection(createOp, txn);

			const mintOp = makeOp(ACTION_MINT, {
				id: seedIdA,
				artId: ART_ID_A,
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 5,
			});
			await handleMint(mintOp, txn);
		});

		// Verify alice owns the NFT
		const nftBefore = await sql`SELECT owner FROM nfts WHERE id = ${seedIdA}`;
		expect(nftBefore).toHaveLength(1);
		expect(nftBefore[0]?.owner).toBe("alice");

		// Now delete the owner counter for alice to force handler failure
		await sql`DELETE FROM owner_nft_counts WHERE owner = 'alice'`;

		// Attempt transfer alice -> bob (which will fail in adjustOwnerNftCount)
		const transferOp = makeOp(
			ACTION_TRANSFER,
			{ nftId: seedIdA, to: "bob" },
			{ signer: "alice", operationId: "test-sp-iso-partial-mutation" },
		);

		await withTransaction(async (txn) => {
			const success = await routeOperation(transferOp, txn);
			expect(success).toBe(false); // Handler failed
		});

		// Verify NFT owner is still "alice" (savepoint rolled back the mutation)
		const nftAfter = await sql`SELECT owner FROM nfts WHERE id = ${seedIdA}`;
		expect(nftAfter[0]?.owner).toBe("alice");

		// Verify invalid_operations has the error
		const invalid = await sql`SELECT reason FROM invalid_operations WHERE operation_id = ${"test-sp-iso-partial-mutation"}`;
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.reason).toContain("Owner NFT count missing");
	});

	it("should allow successful handler mutations to persist", async () => {
		// Setup: Create collection, mint NFT for charlie with valid counters
		const seedIdA = await canonicalSeedId(ART_ID_A, COL_ID);

		await withTransaction(async (txn) => {
			const createOp = makeCreateCollectionOp({
				id: COL_ID,
				name: COL_NAME,
				symbol: COL_SYMBOL,
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/test.png" },
				rules: { transferable: true, burnable: false, royaltyPct: 0 },
			});
			await handleCreateCollection(createOp, txn);

			const mintOp = makeOp(
				ACTION_MINT,
				{
					id: seedIdA,
					artId: ART_ID_A,
					collectionId: COL_ID,
					edition: 1,
					owner: "charlie",
					maxSupply: 5,
				},
				{ signer: "alice" },
			);
			await handleMint(mintOp, txn);
		});

		// Execute successful transfer
		const transferOp = makeOp(
			ACTION_TRANSFER,
			{ nftId: seedIdA, to: "diana" },
			{ signer: "charlie", operationId: "test-sp-iso-successful-transfer" },
		);

		await withTransaction(async (txn) => {
			const success = await routeOperation(transferOp, txn);
			expect(success).toBe(true); // Handler succeeded
		});

		// Verify ownership changed
		const nftAfter = await sql`SELECT owner FROM nfts WHERE id = ${seedIdA}`;
		expect(nftAfter[0]?.owner).toBe("diana");
	});

	it("should prevent contamination when one handler fails and next succeeds in same batch", async () => {
		// Setup: Create collection, mint two NFTs:
		// - seedIdA: alice with corrupted counter (will be deleted)
		// - seedIdB: charlie with valid counter
		const seedIdA = await canonicalSeedId(ART_ID_A, COL_ID);
		const seedIdB = await canonicalSeedId(ART_ID_B, COL_ID);

		await withTransaction(async (txn) => {
			const createOp = makeCreateCollectionOp({
				id: COL_ID,
				name: COL_NAME,
				symbol: COL_SYMBOL,
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/test.png" },
				rules: { transferable: true, burnable: false, royaltyPct: 0 },
			});
			await handleCreateCollection(createOp, txn);

			const mintOpA = makeOp(
				ACTION_MINT,
				{
					id: seedIdA,
					artId: ART_ID_A,
					collectionId: COL_ID,
					edition: 1,
					owner: "alice",
					maxSupply: 5,
				},
				{ signer: "alice" },
			);
			await handleMint(mintOpA, txn);

			const mintOpB = makeOp(
				ACTION_MINT,
				{
					id: seedIdB,
					artId: ART_ID_B,
					collectionId: COL_ID,
					edition: 1,
					owner: "charlie",
					maxSupply: 5,
				},
				{ signer: "alice" },
			);
			await handleMint(mintOpB, txn);
		});

		// Delete alice's counter to force the first transfer to fail
		await sql`DELETE FROM owner_nft_counts WHERE owner = 'alice'`;

		// Execute both transfers in same transaction
		const failingOp = makeOp(
			ACTION_TRANSFER,
			{ nftId: seedIdA, to: "bob" },
			{ signer: "alice", operationId: "test-sp-iso-batch-failing" },
		);

		const succeedingOp = makeOp(
			ACTION_TRANSFER,
			{ nftId: seedIdB, to: "diana" },
			{ signer: "charlie", operationId: "test-sp-iso-batch-succeeding" },
		);

		await withTransaction(async (txn) => {
			const result1 = await routeOperation(failingOp, txn);
			const result2 = await routeOperation(succeedingOp, txn);

			expect(result1).toBe(false); // First should fail
			expect(result2).toBe(true); // Second should succeed
		});

		// Verify NFT_A still owned by alice (no contamination from failed handler)
		const nftA = await sql`SELECT owner FROM nfts WHERE id = ${seedIdA}`;
		expect(nftA[0]?.owner).toBe("alice");

		// Verify NFT_B ownership changed (second op succeeded)
		const nftB = await sql`SELECT owner FROM nfts WHERE id = ${seedIdB}`;
		expect(nftB[0]?.owner).toBe("diana");

		// Verify both operations are recorded
		const invalid = await sql`SELECT operation_id FROM invalid_operations WHERE operation_id = ${"test-sp-iso-batch-failing"}`;
		expect(invalid).toHaveLength(1);
	});
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withTransaction, sql } from "@/db/client.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import type { ParsedOperation, TransferDetail, TransferPool } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";

const COL_NAME = "ConsumedRollback";
const COL_SYMBOL = "CNSMD";
const ART_ID = "art-cnsmd-1";

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
}

describe("router — TransferPool.consumed rollback on handler failure", () => {
	let COL_ID: string;
	let seedId: string;

	beforeEach(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", COL_NAME, COL_SYMBOL);
		seedId = await generateDeterministicSeedId(COL_ID, ART_ID);
		await cleanDb();
	});
	afterEach(cleanDb);

	it("reverts consumed indices when a mutation inside the savepoint fails", async () => {
		// Setup an NFT owned by alice with a corrupted counter so the transfer handler will fail.
		await withTransaction(async (txn) => {
			const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
			const createOp: ParsedOperation = {
				blockNum: 1,
				timestamp: new Date().toISOString(),
				version: PROTOCOL_VERSION,
				txId: `tx_cnsmd_${Date.now()}`,
				operationId: `op_cnsmd_${Date.now()}`,
				signer: config.hiveAccount,
				authLevel: "active",
				action: ACTION_CREATE_COLLECTION,
				data: {
					id: COL_ID,
					name: COL_NAME,
					symbol: COL_SYMBOL,
					totalPotential: 10,
					metadata: { description: "x", image: "https://example.com/x.png" },
					rules: { transferable: true, burnable: false, royaltyPct: 0 },
				},
				pairedTransfers: [
					{
						from: "alice",
						to: config.hiveAccount,
						amount: feeAmount,
						currency: "HBD",
						memo: `NFTLox FEE-COL:${COL_ID}`,
					},
				],
			};
			createOp.payment = {
				kind: "fixed",
				payer: "alice",
				amount: feeAmount,
				currency: "HBD",
				consumedIndices: [0],
			};
			await handleCreateCollection(createOp, txn);

			const mintOp: ParsedOperation = {
				blockNum: 1,
				timestamp: new Date().toISOString(),
				version: PROTOCOL_VERSION,
				txId: `tx_cnsmd_mint_${Date.now()}`,
				operationId: `op_cnsmd_mint_${Date.now()}`,
				signer: "alice",
				authLevel: "active",
				action: ACTION_MINT,
				data: {
					id: seedId,
					artId: ART_ID,
					collectionId: COL_ID,
					edition: 1,
					owner: "alice",
					maxSupply: 5,
				},
			};
			await handleMint(mintOp, txn);
		});

		// Break alice's counter so the next transfer fails inside the handler.
		await sql`DELETE FROM owner_nft_counts WHERE owner = 'alice'`;

		// The transfer op carries a shared transferPool that pre-populates one
		// "already consumed" index — representing another op in the same Hive
		// tx that legitimately claimed a transfer earlier. If the router's
		// rollback is correct, this pool must be identical after the failure.
		const transfers: TransferDetail[] = [
			{ from: "alice", to: "bob", amount: 1, currency: "HIVE", memo: "unrelated" },
		];
		const pool: TransferPool = { transfers, consumed: new Set<number>([0]) };

		const failingOp: ParsedOperation = {
			blockNum: 2,
			timestamp: new Date().toISOString(),
			version: PROTOCOL_VERSION,
			txId: "tx_cnsmd_fail",
			operationId: "op_cnsmd_fail",
			signer: "alice",
			authLevel: "posting",
			action: ACTION_TRANSFER,
			data: { nftId: seedId, to: "bob" },
			pairedTransfers: [],
			transferPool: pool,
		};

		await withTransaction(async (txn) => {
			const ok = await routeOperation(failingOp, txn);
			expect(ok).toBe(false);
		});

		// Rollback invariant: the pool must be exactly what it was before the
		// failed dispatch — size unchanged, index 0 still the only member.
		expect(pool.consumed.size).toBe(1);
		expect(pool.consumed.has(0)).toBe(true);
	});
});

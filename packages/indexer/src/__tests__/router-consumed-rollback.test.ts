import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withTransaction, sql } from "@/db/client.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import type { ParsedOperation, TransferDetail, TransferPool } from "@/scanner/operation-parser.ts";
import {
	ACTION_BUY,
	ACTION_BULK_DISTRIBUTE,
	ACTION_CREATE_COLLECTION,
	ACTION_LIST,
	ACTION_MINT,
	ACTION_TRANSFER,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	PROTOCOL_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	calculatePaymentSplit,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateListingId,
	generateListingNonce,
	generateOriginDna,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";

const COL_NAME = "ConsumedRollback";
const COL_SYMBOL = "CNSMD";
const ART_ID = "art-cnsmd-1";

async function cleanDb(): Promise<void> {
	await sql`DELETE FROM sales`;
	await sql`DELETE FROM nft_allowances`;
	await sql`DELETE FROM collection_allowances`;
	// TRUNCATE nfts (and counters/collections downstream via CASCADE) skips
	// per-row triggers — necessary because tests corrupt owner_nft_counts
	// on purpose and the AFTER DELETE counter trigger would then RAISE.
	await sql`TRUNCATE nfts, owner_nft_counts, collection_stats, collections RESTART IDENTITY CASCADE`;
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM confirmed_operations`;
	await sql`DELETE FROM orphaned_buys`;
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
					originDna: await generateOriginDna(COL_ID),
					totalPotential: 10,
					maxInstances: 0,
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
					nftType: "seed",
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

	// This case DOES exercise the bug the rollback fix targets: verifyTransfers
	// runs inside handleBuy, stages + commits three indices to the shared
	// consumed set, and then updateNftOwner throws (seller's owner_nft_counts
	// row has been deleted mid-test). Without the router's snapshot/restore,
	// those three indices would leak into the next op's view of the pool.
	it("restores consumed indices when verifyTransfers has already mutated them", async () => {
		// Setup: collection, seed mint, instance, active listing owned by alice.
		let instanceId = "";
		let listingMeta = { listingId: "", listTxId: "", txId: "" };

		await withTransaction(async (txn) => {
			const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
			const createOp: ParsedOperation = {
				blockNum: 1,
				timestamp: new Date().toISOString(),
				version: PROTOCOL_VERSION,
				txId: `tx_cnsmd_buy_col_${Date.now()}`,
				operationId: `op_cnsmd_buy_col_${Date.now()}`,
				signer: config.hiveAccount,
				authLevel: "active",
				action: ACTION_CREATE_COLLECTION,
				data: {
					id: COL_ID,
					name: COL_NAME,
					symbol: COL_SYMBOL,
					originDna: await generateOriginDna(COL_ID),
					totalPotential: 10,
					maxInstances: 0,
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
				txId: `tx_cnsmd_buy_mint_${Date.now()}`,
				operationId: `op_cnsmd_buy_mint_${Date.now()}`,
				signer: "alice",
				authLevel: "active",
				action: ACTION_MINT,
				data: {
					id: seedId,
					artId: ART_ID,
					collectionId: COL_ID,
					edition: 1,
					owner: "alice",
					nftType: "seed",
					maxSupply: 5,
				},
			};
			await handleMint(mintOp, txn);

			const [seedRow] = await txn`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
			const seedTxId = seedRow!.tx_id as string;

			const distributeOp: ParsedOperation = {
				blockNum: 1,
				timestamp: new Date().toISOString(),
				version: PROTOCOL_VERSION,
				txId: `tx_cnsmd_buy_dist_${Date.now()}`,
				operationId: `op_cnsmd_buy_dist_${Date.now()}`,
				signer: "alice",
				authLevel: "active",
				action: ACTION_BULK_DISTRIBUTE,
				data: { items: [{ seedId, quantity: 1, seedTxId }] },
			};
			await handleBulkDistribute(distributeOp, txn);

			const [inst] = await txn`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
			instanceId = inst!.id as string;

			const nonce = generateListingNonce();
			const listingId = await generateListingId({
				nftId: instanceId,
				owner: "alice",
				marketplace: "",
				priceAmount: "10.000",
				priceCurrency: "HIVE",
				expiresAt: 0,
				nonce,
			});
			const listOp: ParsedOperation = {
				blockNum: 2,
				timestamp: new Date().toISOString(),
				version: PROTOCOL_VERSION,
				txId: `tx_cnsmd_buy_list_${Date.now()}`,
				operationId: `op_cnsmd_buy_list_${Date.now()}`,
				signer: "alice",
				authLevel: "posting",
				action: ACTION_LIST,
				data: {
					nftId: instanceId,
					listingId,
					listingNonce: nonce,
					price: { amount: "10.000", currency: "HIVE" },
				},
			};
			await handleList(listOp, txn);

			const [listed] = await txn`
				SELECT listing_id, listing_tx_id, created_tx_id AS tx_id
				FROM nfts WHERE id = ${instanceId}
			`;
			listingMeta = {
				listingId: listed!.listing_id as string,
				listTxId: listed!.listing_tx_id as string,
				txId: listed!.tx_id as string,
			};
		});

		// Trip the handler AFTER verifyTransfers has mutated consumed by
		// yanking the seller's counter row.
		await sql`DELETE FROM owner_nft_counts WHERE owner = 'alice'`;

		// Valid buy triplet (seller / fee; no royalty because royaltyPct = 0).
		const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", config.hiveAccount);
		const unrelatedTransfer: TransferDetail = {
			from: "alice", to: "zoe", amount: 1, currency: "HIVE", memo: "unrelated",
		};
		const sellerTransfer: TransferDetail = {
			from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE",
			memo: `${MEMO_PREFIX_BUY}${instanceId}`,
		};
		const feeTransfer: TransferDetail = {
			from: "bob", to: config.hiveAccount, amount: split.feeAmount, currency: "HIVE",
			memo: `${MEMO_PREFIX_FEE}${instanceId}`,
		};
		// Royalty leg omitted: royaltyPct = 0 → calculatePaymentSplit returns
		// royaltyAmount = 0 and no royalty transfer is expected.

		// Index 0 is pre-consumed (another op already claimed it); the buy's
		// two legs live at indices 1 and 2. The router wires pairedTransfers
		// to the SAME array pool.transfers holds, so consumed indices are
		// coherent across both views.
		const transfers: TransferDetail[] = [unrelatedTransfer, sellerTransfer, feeTransfer];
		const pool: TransferPool = { transfers, consumed: new Set<number>([0]) };

		const buyOp: ParsedOperation = {
			blockNum: 3,
			timestamp: new Date().toISOString(),
			version: PROTOCOL_VERSION,
			txId: "tx_cnsmd_buy_fail",
			operationId: "op_cnsmd_buy_fail",
			signer: config.hiveAccount,
			authLevel: "active",
			action: ACTION_BUY,
			data: {
				nftId: instanceId,
				listingId: listingMeta.listingId,
				listTxId: listingMeta.listTxId,
				txId: listingMeta.txId,
			},
			pairedTransfers: transfers,
			transferPool: pool,
		};

		await withTransaction(async (txn) => {
			const ok = await routeOperation(buyOp, txn);
			expect(ok).toBe(false);
		});

		// Rollback invariant: verifyTransfers added indices 1 and 2 to the pool,
		// then updateNftOwner failed. Without the router's consumed-snapshot
		// restore, the pool would contain {0, 1, 2} and leak those claims to
		// the next op in the same Hive tx. The test fails loudly if that
		// regression returns.
		expect(pool.consumed.size).toBe(1);
		expect(pool.consumed.has(0)).toBe(true);
		expect(pool.consumed.has(1)).toBe(false);
		expect(pool.consumed.has(2)).toBe(false);
	});
});

/**
 * sale_lock handler + sweep contract.
 *
 * Validates the on-chain lock lifecycle introduced by C3:
 *   listed → pending_sale (handleSaleLock)
 *   pending_sale → listed  (sweepExpiredSaleLocks at block > expiry)
 *   pending_sale → active  (handleBuy on match)
 *
 * Every rejection path uses a fresh fixture so partial UPDATEs from prior
 * tests cannot mask regressions.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleSaleLock } from "@/processor/handlers/marketplace/sale-lock.ts";
import { handleBuy } from "@/processor/handlers/marketplace/buy.ts";
import { sweepExpiredSaleLocks } from "@/db/queries/nft-mutations.ts";
import { config } from "@/config.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_LIST,
	ACTION_SALE_LOCK,
	ACTION_BUY,
	ACTIVE_AUTH_ACTIONS,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_VERSION,
	SALE_LOCK_DURATION_BLOCKS,
	generateListingNonce,
	generateListingId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	calculatePaymentSplit,
} from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);
const NODE_ACCOUNT = config.hiveAccount;
const BASE_BLOCK = 90_010_000;
const BASE_TIMESTAMP = "2026-03-01T12:00:00";
const SELLER = "alice";
const BUYER = "bob";
const OTHER_BUYER = "carol";
const LIST_PRICE_AMOUNT = "10.000";
const LIST_PRICE_CURRENCY = "HIVE";

let COL_ID: string;
let opCounter = 0;

function makeOp(
	action: string,
	data: Record<string, unknown>,
	overrides: Readonly<{
		blockNum?: number;
		signer?: string;
		timestamp?: string;
		pairedTransfers?: ParsedOperation["pairedTransfers"];
	}> = {},
): ParsedOperation {
	const id = ++opCounter;
	const authLevel: AuthLevel = ACTIVE_SET.has(action) ? "active" : "posting";
	return {
		blockNum: overrides.blockNum ?? BASE_BLOCK,
		timestamp: overrides.timestamp ?? BASE_TIMESTAMP,
		txId: `tx_${action}_${id}`.padEnd(40, "0").slice(0, 40),
		operationId: `op_${id}`,
		signer: overrides.signer ?? SELLER,
		authLevel,
		action: action as ParsedOperation["action"],
		version: PROTOCOL_VERSION,
		data,
		pairedTransfers: overrides.pairedTransfers,
	};
}

async function cleanDb() {
	await sql`DELETE FROM l2_nodes`;
	await sql`DELETE FROM nft_loans`;
	await sql`DELETE FROM nft_allowances`;
	await sql`DELETE FROM burned_nfts`;
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
}

async function seedCollectionAndListedInstance(): Promise<{ instId: string; listingId: string; listTxId: string }> {
	await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: BASE_BLOCK - 10 });
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const collectionOp = makeOp(ACTION_CREATE_COLLECTION, {
		id: COL_ID, name: "Sale Lock Test", symbol: "SLOCK", totalPotential: 100, maxInstances: 0,
		metadata: { description: "sale-lock fixture", image: "https://example.com/i.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 0 },
	}, {
		signer: NODE_ACCOUNT,
		pairedTransfers: [
			{ from: SELLER, to: NODE_ACCOUNT, amount: feeAmount, currency: "HBD", memo: `NFTLox FEE-COL:${COL_ID}` },
		],
	});
	collectionOp.payment = {
		kind: "fixed",
		payer: SELLER,
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};
	await withTransaction((txn) => handleCreateCollection(collectionOp, txn));

	const seedId = await generateDeterministicSeedId(COL_ID, "slock_art");
	await withTransaction((txn) => handleMint(makeOp(ACTION_MINT, {
		id: seedId, artId: "slock_art", collectionId: COL_ID, edition: 1,
		owner: SELLER, maxSupply: 2,
		metadata: { name: "SaleLock", imageUrl: "https://example.com/i.png", imageHash: "x" },
	}), txn));

	const [seedRow] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
	await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
		items: [{ seedId, quantity: 1, seedTxId: seedRow!.tx_id }],
	}), txn));

	const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
	const instId = inst!.id as string;

	const nonce = generateListingNonce();
	const listingId = await generateListingId({
		nftId: instId, owner: SELLER, marketplace: "",
		priceAmount: LIST_PRICE_AMOUNT, priceCurrency: LIST_PRICE_CURRENCY, expiresAt: 0, nonce,
	});
	const listOp = makeOp(ACTION_LIST, {
		nftId: instId, listingId, listingNonce: nonce,
		price: { amount: LIST_PRICE_AMOUNT, currency: LIST_PRICE_CURRENCY },
	});
	await withTransaction((txn) => handleList(listOp, txn));

	return { instId, listingId, listTxId: listOp.txId };
}

async function readSaleFields(instId: string) {
	const [row] = await sql`
		SELECT status, sale_buyer, sale_settlement_node, sale_expires_block,
		       sale_lock_tx_id, sale_lock_operation_id
		FROM nfts WHERE id = ${instId}
	`;
	return row!;
}

describe("sale_lock handler", () => {
	beforeAll(async () => {
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
		COL_ID = await generateDeterministicCollectionId(SELLER, "Sale Lock Test", "SLOCK");
	});

	afterAll(async () => {
		await cleanDb();
		await sql.end();
	});

	beforeEach(async () => {
		await cleanDb();
	});

	test("sale_lock moves listed → pending_sale with snapshot fields", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const lockBlock = BASE_BLOCK + 5;
		const op = makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
			blockNum: lockBlock,
			signer: NODE_ACCOUNT,
		});
		await withTransaction((txn) => handleSaleLock(op, txn));

		const row = await readSaleFields(instId);
		expect(row.status).toBe("pending_sale");
		expect(row.sale_buyer).toBe(BUYER);
		expect(row.sale_settlement_node).toBe(NODE_ACCOUNT);
		expect(Number(row.sale_expires_block)).toBe(lockBlock + SALE_LOCK_DURATION_BLOCKS);
		expect(row.sale_lock_tx_id).toBe(op.txId);
		expect(row.sale_lock_operation_id).toBe(op.operationId);
	});

	test("sale_lock rejects when signer is not an active settlement node", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const op = makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
			signer: "rogue_node",
		});
		await expect(
			withTransaction((txn) => handleSaleLock(op, txn)),
		).rejects.toThrow(/not registered in l2_nodes/);
	});

	test("sale_lock rejects when NFT is not listed", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		// First lock succeeds — row becomes pending_sale.
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, { signer: NODE_ACCOUNT }),
			txn,
		));
		// Second lock on the same (now pending_sale) row must be rejected.
		const op = makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: OTHER_BUYER }, {
			signer: NODE_ACCOUNT,
		});
		await expect(
			withTransaction((txn) => handleSaleLock(op, txn)),
		).rejects.toThrow(/is not listed/);
	});

	test("sale_lock rejects mismatched listingId", async () => {
		const { instId, listTxId } = await seedCollectionAndListedInstance();
		const op = makeOp(ACTION_SALE_LOCK, {
			nftId: instId, listingId: "listing_WRONG", listTxId, buyer: BUYER,
		}, { signer: NODE_ACCOUNT });
		await expect(
			withTransaction((txn) => handleSaleLock(op, txn)),
		).rejects.toThrow(/listingId mismatch/);
	});

	test("sale_lock rejects mismatched listTxId", async () => {
		const { instId, listingId } = await seedCollectionAndListedInstance();
		const op = makeOp(ACTION_SALE_LOCK, {
			nftId: instId, listingId, listTxId: "tx_WRONG", buyer: BUYER,
		}, { signer: NODE_ACCOUNT });
		await expect(
			withTransaction((txn) => handleSaleLock(op, txn)),
		).rejects.toThrow(/listTxId mismatch/);
	});

	test("sale_lock rejects when listing has expired (timestamp check)", async () => {
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: BASE_BLOCK - 10 });
		const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
		const collectionOp = makeOp(ACTION_CREATE_COLLECTION, {
			id: COL_ID, name: "Sale Lock Test", symbol: "SLOCK", totalPotential: 100, maxInstances: 0,
			metadata: { description: "sale-lock fixture", image: "https://example.com/i.png" },
			rules: { transferable: true, burnable: true, royaltyPct: 0 },
		}, {
			signer: NODE_ACCOUNT,
			pairedTransfers: [{ from: SELLER, to: NODE_ACCOUNT, amount: feeAmount, currency: "HBD", memo: `NFTLox FEE-COL:${COL_ID}` }],
		});
		collectionOp.payment = { kind: "fixed", payer: SELLER, amount: feeAmount, currency: "HBD", consumedIndices: [0] };
		await withTransaction((txn) => handleCreateCollection(collectionOp, txn));

		const seedId = await generateDeterministicSeedId(COL_ID, "expiring_art");
		await withTransaction((txn) => handleMint(makeOp(ACTION_MINT, {
			id: seedId, artId: "expiring_art", collectionId: COL_ID, edition: 1,
			owner: SELLER, maxSupply: 2,
			metadata: { name: "Exp", imageUrl: "https://example.com/i.png", imageHash: "x" },
		}), txn));
		const [seedRow] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
		await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
			items: [{ seedId, quantity: 1, seedTxId: seedRow!.tx_id }],
		}), txn));
		const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
		const instId = inst!.id as string;

		// Listing expires 10 minutes after BASE_TIMESTAMP but safely after
		// MIN_LISTING_TTL_MS (handleList rejects sub-floor TTLs).
		const expiresAt = Date.parse(BASE_TIMESTAMP + "Z") + 10 * 60 * 1000;
		const nonce = generateListingNonce();
		const listingId = await generateListingId({
			nftId: instId, owner: SELLER, marketplace: "",
			priceAmount: LIST_PRICE_AMOUNT, priceCurrency: LIST_PRICE_CURRENCY, expiresAt, nonce,
		});
		const listOp = makeOp(ACTION_LIST, {
			nftId: instId, listingId, listingNonce: nonce,
			price: { amount: LIST_PRICE_AMOUNT, currency: LIST_PRICE_CURRENCY },
			expiresAt,
		});
		await withTransaction((txn) => handleList(listOp, txn));

		// sale_lock arrives 30 minutes later — well past expiresAt.
		const lockTimestamp = new Date(expiresAt + 60_000).toISOString().replace("Z", "").replace(/\.\d+$/, "");
		const lockOp = makeOp(ACTION_SALE_LOCK, {
			nftId: instId, listingId, listTxId: listOp.txId, buyer: BUYER,
		}, { blockNum: BASE_BLOCK + 200, signer: NODE_ACCOUNT, timestamp: lockTimestamp });
		await expect(
			withTransaction((txn) => handleSaleLock(lockOp, txn)),
		).rejects.toThrow(/Listing has expired/);
	});

	test("sale_lock rejects when buyer equals seller", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const op = makeOp(ACTION_SALE_LOCK, {
			nftId: instId, listingId, listTxId, buyer: SELLER,
		}, { signer: NODE_ACCOUNT });
		await expect(
			withTransaction((txn) => handleSaleLock(op, txn)),
		).rejects.toThrow(/Cannot sale_lock buyer equal to seller/);
	});

	test("sale_lock rejects a non-existent NFT", async () => {
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: BASE_BLOCK - 10 });
		const op = makeOp(ACTION_SALE_LOCK, {
			nftId: "nft_missing", listingId: "listing_x", listTxId: "tx_x", buyer: BUYER,
		}, { signer: NODE_ACCOUNT });
		await expect(
			withTransaction((txn) => handleSaleLock(op, txn)),
		).rejects.toThrow(/NFT not found/);
	});

	test("sweepExpiredSaleLocks returns expired pending_sale rows to listed", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const lockBlock = BASE_BLOCK + 5;
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: lockBlock, signer: NODE_ACCOUNT,
			}),
			txn,
		));
		const expiresBlock = lockBlock + SALE_LOCK_DURATION_BLOCKS;

		// sweep at exactly expiresBlock leaves the row intact (expired means <).
		const noop = await withTransaction((txn) => sweepExpiredSaleLocks(expiresBlock, txn));
		expect(noop).toBe(0);

		// sweep at expiresBlock + 1 returns the row to 'listed' and clears sale_*.
		const swept = await withTransaction((txn) => sweepExpiredSaleLocks(expiresBlock + 1, txn));
		expect(swept).toBe(1);

		const row = await readSaleFields(instId);
		expect(row.status).toBe("listed");
		expect(row.sale_buyer).toBeNull();
		expect(row.sale_settlement_node).toBeNull();
		expect(row.sale_expires_block).toBeNull();
		expect(row.sale_lock_tx_id).toBeNull();
		expect(row.sale_lock_operation_id).toBeNull();
	});

	test("sale_lock can be re-acquired after sweep returns the NFT to listed", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const firstBlock = BASE_BLOCK + 5;
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: firstBlock, signer: NODE_ACCOUNT,
			}),
			txn,
		));
		const sweepAt = firstBlock + SALE_LOCK_DURATION_BLOCKS + 1;
		await withTransaction((txn) => sweepExpiredSaleLocks(sweepAt, txn));

		const reLockBlock = sweepAt + 1;
		const reLock = makeOp(ACTION_SALE_LOCK, {
			nftId: instId, listingId, listTxId, buyer: OTHER_BUYER,
		}, { blockNum: reLockBlock, signer: NODE_ACCOUNT });
		await withTransaction((txn) => handleSaleLock(reLock, txn));

		const row = await readSaleFields(instId);
		expect(row.status).toBe("pending_sale");
		expect(row.sale_buyer).toBe(OTHER_BUYER);
		expect(Number(row.sale_expires_block)).toBe(reLockBlock + SALE_LOCK_DURATION_BLOCKS);
	});

	test("handleBuy settles a matching sale_lock and clears sale_* + listing_*", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const lockBlock = BASE_BLOCK + 5;
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: lockBlock, signer: NODE_ACCOUNT,
			}),
			txn,
		));

		const totalPrice = parseFloat(LIST_PRICE_AMOUNT);
		const split = calculatePaymentSplit(totalPrice, LIST_PRICE_CURRENCY, 0, null, SELLER, NODE_ACCOUNT);
		const buyOp = makeOp(ACTION_BUY, { nftId: instId, listingId, listTxId }, {
			blockNum: lockBlock + 1,
			signer: NODE_ACCOUNT,
			pairedTransfers: [
				{ from: BUYER, to: SELLER, amount: split.sellerAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: BUYER, to: NODE_ACCOUNT, amount: split.feeAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_FEE}${instId}` },
			],
		});
		await withTransaction((txn) => handleBuy(buyOp, txn));

		const [row] = await sql`
			SELECT owner, status, listing_id, listing_price, sale_buyer, sale_settlement_node
			FROM nfts WHERE id = ${instId}
		`;
		expect(row!.owner).toBe(BUYER);
		expect(row!.status).toBe("active");
		expect(row!.listing_id).toBeNull();
		expect(row!.listing_price).toBeNull();
		expect(row!.sale_buyer).toBeNull();
		expect(row!.sale_settlement_node).toBeNull();
	});

	test("handleBuy rejects when the settlement node differs from sale_settlement_node", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: BASE_BLOCK + 5, signer: NODE_ACCOUNT,
			}),
			txn,
		));
		// Buy handler no longer requires active-node status on the signer
		// (sale_lock handler already did that at lock time). The discriminator
		// is `op.signer === nft.sale_settlement_node`.
		const totalPrice = parseFloat(LIST_PRICE_AMOUNT);
		const split = calculatePaymentSplit(totalPrice, LIST_PRICE_CURRENCY, 0, null, SELLER, NODE_ACCOUNT);
		const buyOp = makeOp(ACTION_BUY, { nftId: instId, listingId, listTxId }, {
			blockNum: BASE_BLOCK + 6,
			signer: "other_node",
			pairedTransfers: [
				{ from: BUYER, to: SELLER, amount: split.sellerAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: BUYER, to: "other_node", amount: split.feeAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_FEE}${instId}` },
			],
		});
		await expect(
			withTransaction((txn) => handleBuy(buyOp, txn)),
		).rejects.toThrow(/sale_settlement_node mismatch/);
	});

	test("handleBuy rejects a buy whose buyer transfer does not match sale_buyer", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: BASE_BLOCK + 5, signer: NODE_ACCOUNT,
			}),
			txn,
		));
		const totalPrice = parseFloat(LIST_PRICE_AMOUNT);
		const split = calculatePaymentSplit(totalPrice, LIST_PRICE_CURRENCY, 0, null, SELLER, NODE_ACCOUNT);
		const buyOp = makeOp(ACTION_BUY, { nftId: instId, listingId, listTxId }, {
			blockNum: BASE_BLOCK + 6,
			signer: NODE_ACCOUNT,
			pairedTransfers: [
				{ from: OTHER_BUYER, to: SELLER, amount: split.sellerAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: OTHER_BUYER, to: NODE_ACCOUNT, amount: split.feeAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_FEE}${instId}` },
			],
		});
		await expect(
			withTransaction((txn) => handleBuy(buyOp, txn)),
		).rejects.toThrow(/sale_buyer mismatch/);
	});

	test("handleBuy rejects when called past sale_expires_block", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const lockBlock = BASE_BLOCK + 5;
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: lockBlock, signer: NODE_ACCOUNT,
			}),
			txn,
		));
		const expiresBlock = lockBlock + SALE_LOCK_DURATION_BLOCKS;
		const totalPrice = parseFloat(LIST_PRICE_AMOUNT);
		const split = calculatePaymentSplit(totalPrice, LIST_PRICE_CURRENCY, 0, null, SELLER, NODE_ACCOUNT);
		const buyOp = makeOp(ACTION_BUY, { nftId: instId, listingId, listTxId }, {
			blockNum: expiresBlock + 1,
			signer: NODE_ACCOUNT,
			pairedTransfers: [
				{ from: BUYER, to: SELLER, amount: split.sellerAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: BUYER, to: NODE_ACCOUNT, amount: split.feeAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_FEE}${instId}` },
			],
		});
		await expect(
			withTransaction((txn) => handleBuy(buyOp, txn)),
		).rejects.toThrow(/sale_lock expired/);
	});

	test("handleBuy rejects when NFT is still listed (no sale_lock was issued)", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		const totalPrice = parseFloat(LIST_PRICE_AMOUNT);
		const split = calculatePaymentSplit(totalPrice, LIST_PRICE_CURRENCY, 0, null, SELLER, NODE_ACCOUNT);
		const buyOp = makeOp(ACTION_BUY, { nftId: instId, listingId, listTxId }, {
			blockNum: BASE_BLOCK + 10,
			signer: NODE_ACCOUNT,
			pairedTransfers: [
				{ from: BUYER, to: SELLER, amount: split.sellerAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: BUYER, to: NODE_ACCOUNT, amount: split.feeAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_FEE}${instId}` },
			],
		});
		await expect(
			withTransaction((txn) => handleBuy(buyOp, txn)),
		).rejects.toThrow(/is not pending_sale/);
	});

	test("handleBuy rejects a buy with a mismatched listingId snapshot", async () => {
		const { instId, listingId, listTxId } = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleSaleLock(
			makeOp(ACTION_SALE_LOCK, { nftId: instId, listingId, listTxId, buyer: BUYER }, {
				blockNum: BASE_BLOCK + 5, signer: NODE_ACCOUNT,
			}),
			txn,
		));
		const totalPrice = parseFloat(LIST_PRICE_AMOUNT);
		const split = calculatePaymentSplit(totalPrice, LIST_PRICE_CURRENCY, 0, null, SELLER, NODE_ACCOUNT);
		const buyOp = makeOp(ACTION_BUY, { nftId: instId, listingId: "listing_OTHER", listTxId }, {
			blockNum: BASE_BLOCK + 6,
			signer: NODE_ACCOUNT,
			pairedTransfers: [
				{ from: BUYER, to: SELLER, amount: split.sellerAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: BUYER, to: NODE_ACCOUNT, amount: split.feeAmount, currency: LIST_PRICE_CURRENCY, memo: `${MEMO_PREFIX_FEE}${instId}` },
			],
		});
		await expect(
			withTransaction((txn) => handleBuy(buyOp, txn)),
		).rejects.toThrow(/listingId mismatch/);
	});
});

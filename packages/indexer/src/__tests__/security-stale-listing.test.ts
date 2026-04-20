/**
 * Security tests: Stale Listing Exploit Prevention
 *
 * Simulates the OpenSea-style vulnerability where old listings remain valid
 * after NFT ownership changes. Verifies that NFTLox correctly invalidates
 * listings, allowances, and prevents stale buy attempts in every transfer path.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, withTransaction, type Queryable } from "@/db/client.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleUnlist } from "@/processor/handlers/marketplace/unlist.ts";
import { handleBuy } from "@/processor/handlers/marketplace/buy.ts";
import { materializePendingUnlists } from "@/db/queries/nft-mutations.ts";
import { handleNftApprove } from "@/processor/handlers/allowances/nft-approve.ts";
import { handleNftApproveAll } from "@/processor/handlers/allowances/nft-approve-all.ts";
import { handleNftTransferFrom } from "@/processor/handlers/allowances/nft-transfer-from.ts";
import { config } from "@/config.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_BUY,
	calculatePaymentSplit,
	ACTIVE_AUTH_ACTIONS,
	generateListingNonce,
	generateListingId,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	PROTOCOL_COLLECTION_FEE_HBD,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	UNLIST_DELAY_BLOCKS,
} from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);
const NODE_ACCOUNT = config.hiveAccount;

let COL_ID: string;
let SEED_SEC1 = "";

let opCounter = 0;
function makeOp(
	action: string,
	data: Record<string, unknown>,
	signer = "alice",
	pairedTransfers?: ParsedOperation["pairedTransfers"],
	authLevel: AuthLevel = ACTIVE_SET.has(action) ? "active" : "posting",
): ParsedOperation {
	const id = ++opCounter;
	return {
		blockNum: 90000100,
		timestamp: "2024-01-01T00:00:00",
		txId: `tx_${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		operationId: `op_sec_${id}`,
		signer,
		authLevel,
		action: action as ParsedOperation["action"],
		version: "0.2.1",
		data,
		pairedTransfers,
	};
}

async function cleanDb() {
	await sql`DELETE FROM nft_loans`;
	await sql`DELETE FROM data_operators`;
	await sql`DELETE FROM nft_allowances`;
	await sql`DELETE FROM collection_allowances`;
	await sql`DELETE FROM burned_nfts`;
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM archived_collections`;
	await sql`DELETE FROM collections`;
}

async function seedCollection(txn?: Queryable): Promise<void> {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const pairedTransfers = [
		{ from: "alice", to: NODE_ACCOUNT, amount: feeAmount, currency: "HBD", memo: `NFTLox FEE-COL:${COL_ID}` },
	];
	const op = makeOp(
		ACTION_CREATE_COLLECTION,
		{
			id: COL_ID,
			name: "Security Test Collection",
			symbol: "SEC",
			totalPotential: 1000,
			maxInstances: 0,
			metadata: { description: "Security test", image: "https://example.com/img.png" },
			rules: { transferable: true, burnable: true, royaltyPct: 5, royaltyRecipient: "alice" },
		},
		NODE_ACCOUNT,
		pairedTransfers,
	);
	op.payment = {
		kind: "fixed",
		payer: "alice",
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};
	if (txn) {
		await handleCreateCollection(op, txn);
		return;
	}
	await withTransaction(async (t) => {
		await handleCreateCollection(op, t);
	});
}

async function seedMint(txn?: Queryable): Promise<void> {
	const op = makeOp(ACTION_MINT, {
		id: SEED_SEC1,
		artId: "sec1",
		collectionId: COL_ID,
		edition: 1,
		owner: "alice",
		maxSupply: 10,
		metadata: { name: "Security Seed", imageUrl: "https://example.com/nft.png", imageHash: "sec_hash" },
	});
	if (txn) {
		await handleMint(op, txn);
		return;
	}
	await withTransaction(async (t) => {
		await handleMint(op, t);
	});
}

async function seedInstance(txn?: Queryable): Promise<string> {
	if (txn) {
		const [row] = await txn`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${SEED_SEC1}`;
		const seedTxId = row!.tx_id as string;
		await handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
			items: [{ seedId: SEED_SEC1, quantity: 1, seedTxId }],
		}), txn);
		const [inst] = await txn`SELECT id FROM nfts WHERE seed_id = ${SEED_SEC1} LIMIT 1`;
		return inst!.id as string;
	}
	return withTransaction(async (t) => {
		const [row] = await t`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${SEED_SEC1}`;
		const seedTxId = row!.tx_id as string;
		await handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
			items: [{ seedId: SEED_SEC1, quantity: 1, seedTxId }],
		}), t);
		const [inst] = await t`SELECT id FROM nfts WHERE seed_id = ${SEED_SEC1} LIMIT 1`;
		return inst!.id as string;
	});
}

async function makeListData(params: {
	nftId: string;
	owner?: string;
	priceAmount?: string;
	priceCurrency?: string;
	expiresAt?: number;
}): Promise<Record<string, unknown>> {
	const nonce = generateListingNonce();
	const amount = params.priceAmount ?? "10.000";
	const currency = params.priceCurrency ?? "HIVE";
	const expiresAt = params.expiresAt ?? 0;

	const listingId = await generateListingId({
		nftId: params.nftId,
		owner: params.owner ?? "alice",
		marketplace: "",
		priceAmount: amount,
		priceCurrency: currency,
		expiresAt,
		nonce,
	});

	return {
		nftId: params.nftId,
		listingId,
		listingNonce: nonce,
		price: { amount, currency },
		...(expiresAt ? { expiresAt } : {}),
	};
}

async function listNft(nftId: string, owner = "alice", priceAmount = "10.000") {
	const listData = await makeListData({ nftId, owner, priceAmount });
	await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData, owner), txn));
	const [nft] = await sql`SELECT listing_id, listing_tx_id, created_tx_id AS tx_id FROM nfts WHERE id = ${nftId}`;
	return {
		listingId: nft!.listing_id as string,
		listTxId: nft!.listing_tx_id as string,
		txId: nft!.tx_id as string,
	};
}

function makeBuyOp(
	nftId: string,
	listingId: string,
	listTxId: string,
	txId: string,
	buyer: string,
	seller: string,
	price = 10,
) {
	const split = calculatePaymentSplit(price, "HIVE", 0, null, seller, NODE_ACCOUNT);
	const transfers = [
		{ from: buyer, to: seller, amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${nftId}` },
		...(split.feeAmount > 0
			? [{ from: buyer, to: NODE_ACCOUNT, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${nftId}` }]
			: []),
	];
	return makeOp(ACTION_BUY, { nftId, listingId, listTxId, txId }, NODE_ACCOUNT, transfers);
}

describe("Security: Stale Listing Exploit Prevention", () => {
	beforeAll(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", "Security Test Collection", "SEC");
		SEED_SEC1 = await generateDeterministicSeedId(COL_ID, "sec1");
		// Drift-immune wipe — see handlers.test.ts for the rationale.
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
	});

	afterAll(async () => {
		await cleanDb();
		await sql.end();
	});

	beforeEach(async () => {
		await cleanDb();
	});

	// ─── Scenario 1: OpenSea Classic ─────────────────────────────
	// Alice lists NFT → Alice transfers to Bob (off-market) → attacker tries to buy with stale listing

	describe("OpenSea classic: list → transfer → stale buy", () => {
		test("direct transfer clears listing fields, stale buy fails", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Alice lists an instance for 10 HIVE
			const { listingId, listTxId, txId } = await listNft(instId);

			// Verify NFT is listed
			const [listed] = await sql`SELECT status, listing_id FROM nfts WHERE id = ${instId}`;
			expect(listed!.status).toBe("listed");
			expect(listed!.listing_id).toBe(listingId);

			// Alice unlists first (required to transfer). Unlist is two-phase
			// now — handler sets pending_unlist_block, materialization flips
			// status to 'active' after UNLIST_DELAY_BLOCKS.
			const unlistOp = makeOp(ACTION_UNLIST, { nftId: instId });
			await withTransaction((txn) => handleUnlist(unlistOp, txn));
			await withTransaction((txn) => materializePendingUnlists(
				unlistOp.blockNum + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn,
			));

			// Alice transfers to Bob
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" }), txn));

			// Verify listing fields are NULLed after transfer
			const [afterTransfer] = await sql`
				SELECT status, owner, listing_id, listing_tx_id, listing_price, listing_currency
				FROM nfts WHERE id = ${instId}
			`;
			expect(afterTransfer!.owner).toBe("bob");
			expect(afterTransfer!.status).toBe("active");
			expect(afterTransfer!.listing_id).toBeNull();
			expect(afterTransfer!.listing_tx_id).toBeNull();
			expect(afterTransfer!.listing_price).toBeNull();
			expect(afterTransfer!.listing_currency).toBeNull();

			// Attacker (eve) tries to buy using stale listing data
			const staleBuyOp = makeBuyOp(instId, listingId, listTxId, txId, "eve", "alice");
			await expect(withTransaction((txn) => handleBuy(staleBuyOp, txn))).rejects.toThrow("not listed");
		});

		test("cannot transfer a listed NFT (must unlist first)", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await listNft(instId);

			const transferOp = makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" });
			await expect(withTransaction((txn) => handleTransfer(transferOp, txn))).rejects.toThrow("listed for sale");
		});
	});

	// ─── Scenario 2: TransferFrom via allowance ──────────────────
	// Alice approves operator → operator transfers NFT → stale listing from before is invalid

	describe("transferFrom clears listing and allowances", () => {
		test("nft_transfer_from clears listing fields and revokes allowance", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Alice approves gameshop as operator for this instance
			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			// Verify allowance exists
			const [allowanceBefore] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(allowanceBefore).toBeDefined();

			// gameshop transfers alice's NFT to charlie
			await withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice", to: "charlie", instanceId: instId,
			}, "gameshop"), txn));

			// Verify listing fields are clean
			const [nft] = await sql`
				SELECT owner, status, listing_id, listing_price
				FROM nfts WHERE id = ${instId}
			`;
			expect(nft!.owner).toBe("charlie");
			expect(nft!.status).toBe("active");
			expect(nft!.listing_id).toBeNull();
			expect(nft!.listing_price).toBeNull();

			// Verify allowance was revoked
			const [allowanceAfter] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(allowanceAfter).toBeUndefined();
		});

		test("old operator cannot transfer after ownership change", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Alice approves gameshop
			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			// gameshop transfers to charlie
			await withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice", to: "charlie", instanceId: instId,
			}, "gameshop"), txn));

			// gameshop tries again with stale approval — must fail
			const staleTransfer = makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "charlie", to: "eve", instanceId: instId,
			}, "gameshop");
			await expect(withTransaction((txn) => handleNftTransferFrom(staleTransfer, txn))).rejects.toThrow("not approved");
		});
	});

	// ─── Scenario 3: Buy clears state for re-listing ─────────────
	// Alice lists → Bob buys → Alice tries to buy back with old listing data

	describe("buy clears listing, prevents replay", () => {
		test("successful buy clears listing; replaying same buy fails", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, listTxId, txId } = await listNft(instId);

			// Bob buys
			const buyOp = makeBuyOp(instId, listingId, listTxId, txId, "bob", "alice");
			await withTransaction((txn) => handleBuy(buyOp, txn));

			// Verify ownership changed and listing cleared
			const [nft] = await sql`
				SELECT owner, status, listing_id, listing_price
				FROM nfts WHERE id = ${instId}
			`;
			expect(nft!.owner).toBe("bob");
			expect(nft!.status).toBe("active");
			expect(nft!.listing_id).toBeNull();

			// Replay: eve tries to buy with exact same stale listing data
			const replayOp = makeBuyOp(instId, listingId, listTxId, txId, "eve", "alice");
			await expect(withTransaction((txn) => handleBuy(replayOp, txn))).rejects.toThrow("not listed");
		});

		test("after buy, new owner can list at different price without conflict", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, listTxId, txId } = await listNft(instId);

			// Bob buys at 10 HIVE
			const buyOp = makeBuyOp(instId, listingId, listTxId, txId, "bob", "alice");
			await withTransaction((txn) => handleBuy(buyOp, txn));

			// Bob re-lists at 20 HIVE — must generate a fresh listingId
			const newListing = await listNft(instId, "bob", "20.000");
			expect(newListing.listingId).not.toBe(listingId);

			const [nft] = await sql`
				SELECT owner, status, listing_id, listing_price
				FROM nfts WHERE id = ${instId}
			`;
			expect(nft!.owner).toBe("bob");
			expect(nft!.status).toBe("listed");
			expect(Number(nft!.listing_price)).toBe(20);
		});
	});

	// ─── Scenario 4: Listing ID forgery ──────────────────────────
	// Attacker tries to craft a buy with fabricated listing data

	describe("listing ID forgery prevention", () => {
		test("fabricated listingId is rejected", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listTxId, txId } = await listNft(instId);

			const forgedBuy = makeBuyOp(instId, "forged_listing_id", listTxId, txId, "eve", "alice");
			await expect(withTransaction((txn) => handleBuy(forgedBuy, txn))).rejects.toThrow("listingId mismatch");
		});

		test("fabricated listTxId is rejected", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, txId } = await listNft(instId);

			const forgedBuy = makeBuyOp(instId, listingId, "forged_tx_id", txId, "eve", "alice");
			await expect(withTransaction((txn) => handleBuy(forgedBuy, txn))).rejects.toThrow("listTxId mismatch");
		});

		test("fabricated txId is rejected", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, listTxId } = await listNft(instId);

			const forgedBuy = makeBuyOp(instId, listingId, listTxId, "forged_nft_tx", "eve", "alice");
			await expect(withTransaction((txn) => handleBuy(forgedBuy, txn))).rejects.toThrow("txId mismatch");
		});
	});

	// ─── Scenario 5: Burn (hard delete) clears everything ──────────────────────

	describe("burn invalidates all marketplace state", () => {
		test("burned (deleted) NFT cannot be listed", async () => {
			await seedCollection();
			await seedMint();

			// Burn (transfer to "null") — hard deletes the row
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_SEC1, to: "null" }), txn));

			const listData = await makeListData({ nftId: SEED_SEC1 });
			const listOp = makeOp(ACTION_LIST, listData);
			await expect(withTransaction((txn) => handleList(listOp, txn))).rejects.toThrow("not found");
		});

		test("burned NFT is recorded in burned_nfts audit table", async () => {
			await seedCollection();
			await seedMint();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_SEC1, to: "null" }), txn));

			const [burned] = await sql`SELECT * FROM burned_nfts WHERE id = ${SEED_SEC1}`;
			expect(burned).toBeDefined();
			expect(burned!.burned_by).toBe("alice");
			expect(burned!.collection_id).toBe(COL_ID);
		});
	});

	// ─── Scenario 6: Collection-level allowance after full transfer ──
	// If alice transfers ALL her NFTs, collection allowance is cleaned up

	describe("collection allowance cleanup on full transfer", () => {
		test("collection allowance removed when owner has no remaining NFTs", async () => {
			await seedCollection();
			await seedMint();

			// Approve gameshop for entire collection
			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "gameshop", collectionId: COL_ID, approved: true,
			}), txn));

			// Transfer alice's only NFT to bob
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_SEC1, to: "bob" }), txn));

			// Collection allowance should be cleaned up since alice has no more NFTs
			const [allowance] = await sql`
				SELECT * FROM collection_allowances
				WHERE owner = 'alice' AND collection_id = ${COL_ID}
			`;
			expect(allowance).toBeUndefined();
		});
	});

	// ─── Scenario 7: Expired listing auto-clear on transfer ──────
	// If a listing expired, transfer should auto-clear it

	describe("expired listing auto-clear", () => {
		test("transfer auto-clears expired listing without manual unlist", async () => {
			await seedCollection();
			await seedMint();

			// Force-set an expired listing via SQL. Must also bump collection_stats.listed
			// or the transfer's auto-clear-listing step trips a CHECK constraint when it
			// tries to decrement listed_count from 0.
			await sql`
				UPDATE nfts
				SET status = 'listed', listing_id = 'exp_listing', listing_tx_id = 'tx_exp',
					listing_price = 10, listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${SEED_SEC1}
			`;
			await sql`UPDATE collection_stats SET listed = listed + 1 WHERE collection_id = ${COL_ID}`;

			// Transfer should succeed (auto-clears expired listing)
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_SEC1, to: "bob" }), txn));

			const [nft] = await sql`
				SELECT owner, status, listing_id, listing_price
				FROM nfts WHERE id = ${SEED_SEC1}
			`;
			expect(nft!.owner).toBe("bob");
			expect(nft!.status).toBe("active");
			expect(nft!.listing_id).toBeNull();
		});

		test("buy with expired listing is rejected even with valid IDs", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Force-set an expired listing
			const expListingId = "exp_list_valid";
			const expListTxId = "tx_exp_valid";
			const [nftRow] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${instId}`;
			const nftTxId = nftRow!.tx_id as string;

			await sql`
				UPDATE nfts
				SET status = 'listed', listing_id = ${expListingId}, listing_tx_id = ${expListTxId},
					listing_price = 10, listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${instId}
			`;

			// Even with matching IDs, expired listing must be rejected
			const buyOp = makeBuyOp(instId, expListingId, expListTxId, nftTxId, "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("expired");
		});
	});

	// ─── Scenario 8: Non-node signer buy rejection ───────────────
	// Only the co-signing node can submit buy operations

	describe("buy signer restriction", () => {
		test("buy signed by non-node account is rejected", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, listTxId, txId } = await listNft(instId);

			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", NODE_ACCOUNT);
			const transfers = [
				{ from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: "bob", to: NODE_ACCOUNT, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` },
			];
			// Attacker signs as "eve" instead of node account
			const attackOp = makeOp(ACTION_BUY, {
				nftId: instId, listingId, listTxId, txId,
			}, "eve", transfers);

			await expect(withTransaction((txn) => handleBuy(attackOp, txn))).rejects.toThrow("node account");
		});
	});
});

/**
 * Unlist-delay protocol test.
 *
 * `handleUnlist` no longer materializes 'listed → active' immediately. It
 * stamps pending_unlist_block and the NFT stays listed for UNLIST_DELAY_BLOCKS
 * blocks so an in-flight multisig buy can still land. At block +DELAY the
 * sync-engine batch-materializes every NFT past its deadline in one UPDATE.
 *
 * This test exercises the two moving pieces: the handler's stamp, and the
 * batch materializer's boundary arithmetic.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleUnlist } from "@/processor/handlers/marketplace/unlist.ts";
import { handleBuy } from "@/processor/handlers/marketplace/buy.ts";
import { materializePendingUnlists } from "@/db/queries/nft-mutations.ts";
import { config } from "@/config.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTIVE_AUTH_ACTIONS,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_VERSION,
	UNLIST_DELAY_BLOCKS,
	calculatePaymentSplit,
	generateListingNonce,
	generateListingId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
} from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);
const NODE_ACCOUNT = config.hiveAccount;
const UNLIST_BLOCK = 90_002_000;

let COL_ID: string;

let opCounter = 0;
function makeOp(
	action: string,
	data: Record<string, unknown>,
	blockNum = UNLIST_BLOCK,
	signer = "alice",
	pairedTransfers?: ParsedOperation["pairedTransfers"],
): ParsedOperation {
	const id = ++opCounter;
	const authLevel: AuthLevel = ACTIVE_SET.has(action) ? "active" : "posting";
	return {
		blockNum,
		timestamp: "2025-02-01T12:00:00",
		txId: `tx_${action}_${id}`,
		operationId: `op_${id}`,
		signer,
		authLevel,
		action: action as ParsedOperation["action"],
		version: PROTOCOL_VERSION,
		data,
		pairedTransfers,
	};
}

async function cleanDb() {
	await sql`DELETE FROM multisig_locks`;
	await sql`DELETE FROM nft_loans`;
	await sql`DELETE FROM nft_allowances`;
	await sql`DELETE FROM burned_nfts`;
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM owner_nft_counts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
}

async function seedCollectionAndListedInstance(): Promise<string> {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const collectionOp = makeOp(ACTION_CREATE_COLLECTION, {
		id: COL_ID, name: "Delay Test", symbol: "DELAY", totalPotential: 100,
		metadata: { description: "delay fixture", image: "https://example.com/i.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 0 },
	}, UNLIST_BLOCK, NODE_ACCOUNT, [
		{ from: "alice", to: NODE_ACCOUNT, amount: feeAmount, currency: "HBD", memo: "" },
	]);
	await withTransaction((txn) => handleCreateCollection(collectionOp, txn));

	const seedId = await generateDeterministicSeedId(COL_ID, "delay_art");
	await withTransaction((txn) => handleMint(makeOp(ACTION_MINT, {
		id: seedId, artId: "delay_art", collectionId: COL_ID, edition: 1,
		owner: "alice", maxSupply: 2,
		metadata: { name: "Delay", imageUrl: "https://example.com/i.png", imageHash: "x" },
	}), txn));

	const [seed] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
	await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
		items: [{ seedId, quantity: 1, seedTxId: seed!.tx_id }],
	}), txn));

	const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
	const instId = inst!.id as string;

	const nonce = generateListingNonce();
	const listingId = await generateListingId({
		nftId: instId, owner: "alice", marketplace: "",
		priceAmount: "10.000", priceCurrency: "HIVE", expiresAt: 0, nonce,
	});
	await withTransaction((txn) => handleList(makeOp(ACTION_LIST, {
		nftId: instId, listingId, listingNonce: nonce,
		price: { amount: "10.000", currency: "HIVE" },
	}), txn));

	return instId;
}

describe("unlist-delay protocol", () => {
	beforeAll(async () => {
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
		COL_ID = await generateDeterministicCollectionId("alice", "Delay Test", "DELAY");
	});

	afterAll(async () => {
		await cleanDb();
		await sql.end();
	});

	beforeEach(async () => {
		await cleanDb();
	});

	test("unlist stamps pending_unlist_block and leaves status='listed'", async () => {
		const instId = await seedCollectionAndListedInstance();

		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		const [row] = await sql`
			SELECT status, listing_id, pending_unlist_block
			FROM nfts WHERE id = ${instId}
		`;
		expect(row!.status).toBe("listed");
		expect(row!.listing_id).not.toBeNull();
		expect(Number(row!.pending_unlist_block)).toBe(UNLIST_BLOCK);
	});

	test("transfer is rejected during the pending-unlist window", async () => {
		const instId = await seedCollectionAndListedInstance();

		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		await expect(
			withTransaction((txn) => handleTransfer(
				makeOp(ACTION_TRANSFER, { nftId: instId, to: "charlie" }, UNLIST_BLOCK + 1),
				txn,
			)),
		).rejects.toThrow(/listed for sale/);
	});

	test("double-unlist is rejected — only one pending stamp allowed", async () => {
		const instId = await seedCollectionAndListedInstance();

		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		await expect(
			withTransaction((txn) => handleUnlist(
				makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK + 1),
				txn,
			)),
		).rejects.toThrow(/already has a pending unlist/);
	});

	test("materialize BELOW the boundary leaves the NFT listed", async () => {
		const instId = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		// At block X + DELAY - 1, threshold = X - 1 → pending_unlist_block (X) > threshold → preserved
		const count = await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS - 1, UNLIST_DELAY_BLOCKS, txn),
		);
		expect(count).toBe(0);

		const [row] = await sql`SELECT status, pending_unlist_block FROM nfts WHERE id = ${instId}`;
		expect(row!.status).toBe("listed");
		expect(Number(row!.pending_unlist_block)).toBe(UNLIST_BLOCK);
	});

	test("materialize AT the boundary flips status back to 'active' and clears listing", async () => {
		const instId = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		const count = await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn),
		);
		expect(count).toBe(1);

		const [row] = await sql`
			SELECT status, listing_id, listing_tx_id, listing_price, listing_currency,
			       listing_expires_at, listing_marketplace, pending_unlist_block
			FROM nfts WHERE id = ${instId}
		`;
		expect(row!.status).toBe("active");
		expect(row!.listing_id).toBeNull();
		expect(row!.listing_tx_id).toBeNull();
		expect(row!.listing_price).toBeNull();
		expect(row!.listing_currency).toBeNull();
		expect(row!.pending_unlist_block).toBeNull();
	});

	test("materialize decrements collection_stats.listed per-collection in ONE update", async () => {
		const instId = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));
		const before = await sql`SELECT listed FROM collection_stats WHERE collection_id = ${COL_ID}`;
		expect(Number(before[0]!.listed)).toBe(1);

		await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn),
		);

		const after = await sql`SELECT listed FROM collection_stats WHERE collection_id = ${COL_ID}`;
		expect(Number(after[0]!.listed)).toBe(0);
	});

	test("materialize is idempotent — running it twice yields zero the second time", async () => {
		const instId = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		const first = await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn),
		);
		const second = await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn),
		);
		expect(first).toBe(1);
		expect(second).toBe(0);

		// Prevent unused-binding warning — the second assertion is on the NFT state
		const [row] = await sql`SELECT status FROM nfts WHERE id = ${instId}`;
		expect(row!.status).toBe("active");
	});

	// ─────────────────────────────────────────────────────────────────────
	// Regression: pending_unlist_block must be cleared on ownership change.
	// Otherwise a successful in-window buy would leave the column stale; on
	// the new owner's re-list, the next batch's materializePendingUnlists
	// would silently revert their listing back to 'active' (and the new
	// owner could not even call unlist manually because markPendingUnlist
	// requires pending_unlist_block IS NULL).
	// ─────────────────────────────────────────────────────────────────────
	test("buy inside the window clears pending_unlist_block (regression: stale stamp)", async () => {
		const instId = await seedCollectionAndListedInstance();
		const [listing] = await sql`
			SELECT listing_id, listing_tx_id, created_tx_id, listing_price
			FROM nfts WHERE id = ${instId}
		`;
		const listingId = listing!.listing_id as string;
		const listTxId = listing!.listing_tx_id as string;
		const txId = listing!.created_tx_id as string;
		const price = Number(listing!.listing_price);

		// Alice unlists at UNLIST_BLOCK; pending_unlist_block stamped, status stays 'listed'.
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		// Bob buys ONE block into the window (in-flight multisig settlement).
		const split = calculatePaymentSplit(price, "HIVE", 0, null, "alice", NODE_ACCOUNT);
		const transfers = [
			{ from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
			...(split.feeAmount > 0
				? [{ from: "bob", to: NODE_ACCOUNT, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` }]
				: []),
		];
		const buyOp = makeOp(
			ACTION_BUY,
			{ nftId: instId, listingId, listTxId, txId },
			UNLIST_BLOCK + 1,
			NODE_ACCOUNT,
			transfers,
		);
		await withTransaction((txn) => handleBuy(buyOp, txn));

		const [row] = await sql`
			SELECT owner, status, pending_unlist_block, listing_id
			FROM nfts WHERE id = ${instId}
		`;
		expect(row!.owner).toBe("bob");
		expect(row!.status).toBe("active");
		expect(row!.listing_id).toBeNull();
		expect(row!.pending_unlist_block).toBeNull();
	});

	test("CHECK constraint rejects pending_unlist_block on an active NFT (DB-level backstop)", async () => {
		const instId = await seedCollectionAndListedInstance();
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));
		await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn),
		);
		// status is now 'active', pending_unlist_block is NULL.
		// Any future code path that tries to set the stamp without flipping
		// status='listed' first must fail loudly at the DB boundary. We use
		// withTransaction so the rejecting query is properly awaited inside an
		// explicit BEGIN/ROLLBACK boundary — postgres.js's lazy thenable can
		// otherwise interact poorly with bun's `rejects` matcher.
		let caught: unknown = null;
		try {
			await withTransaction((txn) =>
				txn`UPDATE nfts SET pending_unlist_block = 999 WHERE id = ${instId}`,
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(/chk_nfts_pending_unlist_only_when_listed/);
	});

	// ─────────────────────────────────────────────────────────────────────
	// Regression: re-listing over an expired listing while a prior unlist's
	// pending_unlist_block is still stamped must CLEAR the stamp. Otherwise
	// the next materialize sweep would silently wipe the fresh listing —
	// same failure class as the updateNftOwner regression above, different
	// code path (updateNftListing re-list branch).
	// ─────────────────────────────────────────────────────────────────────
	test("re-list over expired+pending clears pending_unlist_block (regression: silent wipe)", async () => {
		const instId = await seedCollectionAndListedInstance();

		// Owner unlists first → pending_unlist_block stamped at UNLIST_BLOCK,
		// status stays 'listed'.
		await withTransaction((txn) => handleUnlist(
			makeOp(ACTION_UNLIST, { nftId: instId }, UNLIST_BLOCK),
			txn,
		));

		// Simulate the original listing expiring inside the pending window
		// (force-expire the timestamp directly; handlers never materialize
		// expiry on their own, so a stale 'listed' + expired is realistic).
		await sql`
			UPDATE nfts
			SET listing_expires_at = ${new Date("2000-01-01T00:00:00Z").toISOString()}
			WHERE id = ${instId}
		`;

		// Owner re-lists at UNLIST_BLOCK + 1 (still inside the pending window).
		// list.ts permits this because hadExpiredListing=true.
		const nonce = generateListingNonce();
		const newListingId = await generateListingId({
			nftId: instId, owner: "alice", marketplace: "",
			priceAmount: "20.000", priceCurrency: "HIVE", expiresAt: 0, nonce,
		});
		await withTransaction((txn) => handleList(makeOp(ACTION_LIST, {
			nftId: instId, listingId: newListingId, listingNonce: nonce,
			price: { amount: "20.000", currency: "HIVE" },
		}, UNLIST_BLOCK + 1), txn));

		// Before the fix, pending_unlist_block remained pinned to UNLIST_BLOCK
		// and the next materialize sweep would wipe the fresh listing.
		const [stamped] = await sql`SELECT pending_unlist_block FROM nfts WHERE id = ${instId}`;
		expect(stamped!.pending_unlist_block).toBeNull();

		// Crossing the original unlist's deadline must NOT affect the new
		// listing now that the stamp is cleared.
		const count = await withTransaction((txn) =>
			materializePendingUnlists(UNLIST_BLOCK + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn),
		);
		expect(count).toBe(0);

		const [row] = await sql`
			SELECT status, listing_id, listing_price, pending_unlist_block
			FROM nfts WHERE id = ${instId}
		`;
		expect(row!.status).toBe("listed");
		expect(row!.listing_id).toBe(newListingId);
		expect(Number(row!.listing_price)).toBe(20);
		expect(row!.pending_unlist_block).toBeNull();
	});
});

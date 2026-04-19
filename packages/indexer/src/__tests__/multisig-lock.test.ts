/**
 * Handler-side multisig-lock gate.
 *
 * Verifies that ownership-mutating handlers refuse to run while a durable
 * multisig_locks row is active for the NFT. This is the defensive half of
 * the lock (API-side acquisition is tested in multisig-nft-lock.test.ts).
 *
 * All checks use op.timestamp as the clock — handlers must compare against
 * the block's observed time, not wall-clock NOW(), so two nodes processing
 * the same block reach the same conclusion.
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
import { handleNftApprove } from "@/processor/handlers/allowances/nft-approve.ts";
import { handleNftTransferFrom } from "@/processor/handlers/allowances/nft-transfer-from.ts";
import { handleNftLend } from "@/processor/handlers/lending/nft-lend.ts";
import {
	consumeMultisigLockIfMatches,
	getActiveMultisigLock,
} from "@/utils/multisig-locks.ts";
import { config } from "@/config.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_NFT_APPROVE,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND,
	ACTIVE_AUTH_ACTIONS,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_VERSION,
	generateListingNonce,
	generateListingId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
} from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);
const NODE_ACCOUNT = config.hiveAccount;

// Block 1000, timestamp chosen so we can craft expired/active lock scenarios
const BLOCK = 90_001_000;
const BLOCK_TIMESTAMP = "2025-01-15T12:00:00";
const BLOCK_TIMESTAMP_MS = Date.parse(BLOCK_TIMESTAMP + "Z");

let COL_ID: string;

let opCounter = 0;
function makeOp(
	action: string,
	data: Record<string, unknown>,
	signer = "alice",
	pairedTransfers?: ParsedOperation["pairedTransfers"],
): ParsedOperation {
	const id = ++opCounter;
	const authLevel: AuthLevel = ACTIVE_SET.has(action) ? "active" : "posting";
	return {
		blockNum: BLOCK,
		timestamp: BLOCK_TIMESTAMP,
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

async function seedCollection(): Promise<void> {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const pairedTransfers = [
		{ from: "alice", to: NODE_ACCOUNT, amount: feeAmount, currency: "HBD", memo: `NFTLox FEE-COL:${COL_ID}` },
	];
	const op = makeOp(ACTION_CREATE_COLLECTION, {
		id: COL_ID, name: "Lock Test", symbol: "LOCK", totalPotential: 100,
		metadata: { description: "lock fixture", image: "https://example.com/i.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 0 },
	}, NODE_ACCOUNT, pairedTransfers);
	op.payment = {
		kind: "fixed",
		payer: "alice",
		amount: feeAmount,
		currency: "HBD",
		consumedIndices: [0],
	};
	await withTransaction((txn) => handleCreateCollection(op, txn));
}

async function seedInstance(): Promise<string> {
	const seedId = await generateDeterministicSeedId(COL_ID, "lock_art");
	await withTransaction((txn) => handleMint(makeOp(ACTION_MINT, {
		id: seedId, artId: "lock_art", collectionId: COL_ID, edition: 1,
		owner: "alice", maxSupply: 2,
		metadata: { name: "Lock", imageUrl: "https://example.com/i.png", imageHash: "x" },
	}), txn));
	const [seed] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
	await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
		items: [{ seedId, quantity: 1, seedTxId: seed!.tx_id }],
	}), txn));
	const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
	return inst!.id as string;
}

async function seedListedInstance(): Promise<string> {
	const instId = await seedInstance();
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

async function insertLock(
	params: Readonly<{
		nftId: string;
		buyer?: string;
		listingId?: string;
		listTxId?: string;
		expiresOffsetMs?: number;
	}>,
): Promise<void> {
	const buyer = params.buyer ?? "bob";
	const listingId = params.listingId ?? "listing_lock_1";
	const listTxId = params.listTxId ?? "tx_list_1";
	// expires_at is anchored to the BLOCK timestamp so "active" means "future
	// relative to op.timestamp", matching the handler's comparison clock.
	const offset = params.expiresOffsetMs ?? 60_000;
	const expiresAt = new Date(BLOCK_TIMESTAMP_MS + offset).toISOString();
	await sql`
		INSERT INTO multisig_locks (nft_id, action, buyer, listing_id, list_tx_id, snapshot_block, expires_at)
		VALUES (${params.nftId}, 'buy', ${buyer}, ${listingId}, ${listTxId}, ${BLOCK - 1}, ${expiresAt})
	`;
}

describe("multisig-lock handler gate", () => {
	beforeAll(async () => {
		await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
		const schemaFile = Bun.file(import.meta.dir + "/../db/schema.sql");
		await sql.unsafe(await schemaFile.text());
		COL_ID = await generateDeterministicCollectionId("alice", "Lock Test", "LOCK");
	});

	afterAll(async () => {
		await cleanDb();
		await sql.end();
	});

	beforeEach(async () => {
		await cleanDb();
		await seedCollection();
	});

	test("transfer is rejected while an active lock exists", async () => {
		const instId = await seedInstance();
		await insertLock({ nftId: instId });

		await expect(
			withTransaction((txn) => handleTransfer(
				makeOp(ACTION_TRANSFER, { nftId: instId, to: "charlie" }),
				txn,
			)),
		).rejects.toThrow(/multisig_lock_active/);
	});

	test("burn (transfer to null) is rejected while an active lock exists", async () => {
		const instId = await seedInstance();
		await insertLock({ nftId: instId });

		await expect(
			withTransaction((txn) => handleTransfer(
				makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }),
				txn,
			)),
		).rejects.toThrow(/multisig_lock_active/);
	});

	test("nft_transfer_from is rejected while an active lock exists", async () => {
		const instId = await seedInstance();
		await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
			spender: "gameshop", instanceId: instId, approved: true,
		}), txn));
		await insertLock({ nftId: instId });

		await expect(
			withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice", to: "charlie", instanceId: instId,
			}, "gameshop"), txn)),
		).rejects.toThrow(/multisig_lock_active/);
	});

	test("unlist is rejected while an active lock exists", async () => {
		const instId = await seedListedInstance();
		await insertLock({ nftId: instId });

		await expect(
			withTransaction((txn) => handleUnlist(
				makeOp(ACTION_UNLIST, { nftId: instId }),
				txn,
			)),
		).rejects.toThrow(/multisig_lock_active/);

		const [row] = await sql`SELECT pending_unlist_block FROM nfts WHERE id = ${instId}`;
		expect(row!.pending_unlist_block).toBeNull();
	});

	test("expired lock (expires_at < op.timestamp) does NOT block a transfer", async () => {
		const instId = await seedInstance();
		// offset=-10_000 → lock expired 10s before the block's clock
		await insertLock({ nftId: instId, expiresOffsetMs: -10_000 });

		await withTransaction((txn) => handleTransfer(
			makeOp(ACTION_TRANSFER, { nftId: instId, to: "charlie" }),
			txn,
		));

		const [nft] = await sql`SELECT owner FROM nfts WHERE id = ${instId}`;
		expect(nft!.owner).toBe("charlie");
	});

	test("getActiveMultisigLock ignores expired rows", async () => {
		const instId = await seedInstance();
		await insertLock({ nftId: instId, expiresOffsetMs: -1 });

		const lock = await withTransaction((txn) =>
			getActiveMultisigLock(instId, BLOCK_TIMESTAMP, txn as unknown as Queryable),
		);
		expect(lock).toBeNull();
	});

	test("consumeMultisigLockIfMatches deletes only on full match", async () => {
		const instId = await seedInstance();
		await insertLock({
			nftId: instId, buyer: "bob",
			listingId: "listing_match", listTxId: "tx_list_match",
		});

		// Wrong listing_id → lock preserved
		const wrong = await withTransaction((txn) => consumeMultisigLockIfMatches({
			nftId: instId, buyer: "bob",
			listingId: "listing_OTHER", listTxId: "tx_list_match",
			blockTimestamp: BLOCK_TIMESTAMP, txn: txn as unknown as Queryable,
		}));
		expect(wrong.outcome).toBe("foreign_lock");
		const [still] = await sql`SELECT 1 AS ok FROM multisig_locks WHERE nft_id = ${instId}`;
		expect(still).toBeDefined();

		// Full match → consumed
		const right = await withTransaction((txn) => consumeMultisigLockIfMatches({
			nftId: instId, buyer: "bob",
			listingId: "listing_match", listTxId: "tx_list_match",
			blockTimestamp: BLOCK_TIMESTAMP, txn: txn as unknown as Queryable,
		}));
		expect(right.outcome).toBe("consumed");
		const [gone] = await sql`SELECT 1 AS ok FROM multisig_locks WHERE nft_id = ${instId}`;
		expect(gone).toBeUndefined();
	});

	test("lock on a DIFFERENT NFT does not block a transfer of ours", async () => {
		const instId = await seedInstance();
		await insertLock({ nftId: "nft_UNRELATED" });

		await withTransaction((txn) => handleTransfer(
			makeOp(ACTION_TRANSFER, { nftId: instId, to: "charlie" }),
			txn,
		));

		const [nft] = await sql`SELECT owner FROM nfts WHERE id = ${instId}`;
		expect(nft!.owner).toBe("charlie");
	});

	test("nft_lend is rejected when lock is active (defense in depth)", async () => {
		// NOTE: reachability requires status='active', which seedInstance gives us.
		// The gate is cheap and survives future protocol changes that might widen
		// the set of states from which lending is legal.
		const instId = await seedInstance();
		await insertLock({ nftId: instId });

		await expect(
			withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId, borrower: "renter",
			}), txn)),
		).rejects.toThrow(/multisig_lock_active/);
	});
});

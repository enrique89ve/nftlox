/**
 * Regression tests for the multisig co-signing service.
 *
 * Covers NFT state validation (non-transferable, not-listed, expired, buy-own),
 * request shape validation, transaction structure, and payment split guards.
 *
 * Uses real DB (same pattern as handlers.test.ts) — no mocks.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { sql } from "@/db/client.ts";
import { processMultisigRequest } from "@/api/services/multisig-service.ts";

// Mock beekeeper signer — rejection tests never reach signing
mock.module("@/api/services/beekeeper-signer.ts", () => ({
	signWithBeekeeper: () => "mock_signature",
	isBeekeeperReady: () => true,
	getSignerPublicKey: () => "STM_mock_pubkey",
}));
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { config } from "@/config.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_LIST,
	ACTION_BUY,
	ACTIVE_AUTH_ACTIONS,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	calculatePaymentSplit,
	generateListingNonce,
	generateListingId,
	generateDeterministicCollectionId,
	type MultisigResponse,
	type MultisigErrorCode,
} from "@/protocol/index.ts";

// ============ CONSTANTS ============

const NODE_ACCOUNT = config.hiveAccount;
const PROTOCOL_ID = config.protocolId;
const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);


// ============ HELPERS ============

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
		txId: `tx_${action}_${Date.now()}`,
		operationId: `op_ms_${id}`,
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
	await sql`DELETE FROM collections`;
}

async function seedCollection(
	name = "Multisig Test",
	symbol = "MSTEST",
	transferable = true,
	royaltyPct = 0,
): Promise<string> {
	const id = await generateDeterministicCollectionId("alice", name, symbol);
	const op = makeOp(ACTION_CREATE_COLLECTION, {
		id,
		name,
		symbol,
		totalPotential: 1000,
		metadata: { description: `Test collection ${name}`, image: "https://example.com/img.png" },
		rules: { transferable, burnable: true, replicable: true, royaltyPct },
	});
	await handleCreateCollection(op, sql);
	return id;
}

async function seedMint(nftId = "seed_test1", collectionId: string) {
	const op = makeOp(ACTION_MINT, {
		id: nftId,
		collectionId,
		edition: 1,
		owner: "alice",
		maxReplicas: 10,
		metadata: { name: `NFT ${nftId}`, imageUrl: "https://example.com/nft.png", imageHash: "img_abc" },
	});
	await handleMint(op, sql);
}

async function makeListData(nftId: string, priceAmount = "10.000") {
	const nonce = generateListingNonce();
	const listingId = await generateListingId({
		nftId,
		owner: "alice",
		marketplace: "",
		priceAmount,
		priceCurrency: "HIVE",
		expiresAt: 0,
		nonce,
	});
	return { nftId, listingId, listingNonce: nonce, price: { amount: priceAmount, currency: "HIVE" } };
}

async function listNft(nftId: string, priceAmount = "10.000") {
	const listData = await makeListData(nftId, priceAmount);
	await handleList(makeOp(ACTION_LIST, listData), sql);
	const [nft] = await sql`SELECT listing_id, listing_tx_id, tx_id FROM nfts WHERE id = ${nftId}`;
	return { listingId: nft!.listing_id as string, listTxId: nft!.listing_tx_id as string, nftTxId: nft!.tx_id as string };
}

/**
 * Force-list an NFT via SQL — bypasses handler's transferable check.
 * Required for testing the multisig service's own transferable guard.
 */
async function forceListViaSql(nftId: string, listingId = "list_forced", listTxId = "tx_forced") {
	await sql`
		UPDATE nfts
		SET status = 'listed',
			listing_id = ${listingId},
			listing_tx_id = ${listTxId},
			listing_price = 10,
			listing_currency = 'HIVE'
		WHERE id = ${nftId}
	`;
	return { listingId, listTxId };
}

function makeExpiration(offsetMs = 60_000): string {
	return new Date(Date.now() + offsetMs).toISOString().replace("Z", "").split(".")[0]!;
}

/**
 * Builds a structurally valid multisig request body that passes
 * shape + transaction structure validation, reaching NFT state checks.
 */
function makeMultisigBody(params: {
	buyer: string;
	nftId: string;
	listingId: string;
	listTxId: string;
	nftTxId?: string;
	seller: string;
	price?: number;
	currency?: string;
	royaltyPct?: number;
	royaltyRecipient?: string | null;
	expirationOffsetMs?: number;
}): Record<string, unknown> {
	const {
		buyer, nftId, listingId, listTxId, nftTxId = "", seller,
		price = 10, currency = "HIVE",
		royaltyPct = 0, royaltyRecipient = null,
		expirationOffsetMs = 60_000,
	} = params;

	const split = calculatePaymentSplit(price, currency, royaltyPct, royaltyRecipient, seller, NODE_ACCOUNT);
	const expiration = makeExpiration(expirationOffsetMs);

	const transfers: Array<[string, Record<string, unknown>]> = [];

	if (split.sellerAmount > 0) {
		transfers.push(["transfer", {
			from: buyer,
			to: seller,
			amount: `${split.sellerAmount.toFixed(3)} ${currency}`,
			memo: `${MEMO_PREFIX_BUY}${nftId}`,
		}]);
	}

	if (split.royaltyAmount > 0 && split.royaltyRecipient) {
		transfers.push(["transfer", {
			from: buyer,
			to: split.royaltyRecipient,
			amount: `${split.royaltyAmount.toFixed(3)} ${currency}`,
			memo: `${MEMO_PREFIX_ROYALTY}${nftId}`,
		}]);
	}

	if (split.feeAmount > 0) {
		transfers.push(["transfer", {
			from: buyer,
			to: NODE_ACCOUNT,
			amount: `${split.feeAmount.toFixed(3)} ${currency}`,
			memo: `${MEMO_PREFIX_FEE}${nftId}`,
		}]);
	}

	const customJson: [string, Record<string, unknown>] = ["custom_json", {
		required_auths: [NODE_ACCOUNT],
		required_posting_auths: [],
		id: PROTOCOL_ID,
		json: JSON.stringify({
			action: ACTION_BUY,
			data: { nftId, txId: nftTxId, listingId, listTxId },
		}),
	}];

	return {
		buyer,
		nftId,
		listingId,
		listTxId,
		transaction: {
			ref_block_num: 1234,
			ref_block_prefix: 5678,
			expiration,
			operations: [...transfers, customJson],
			extensions: [],
			signatures: [],
		},
	};
}

function getTransaction(body: Record<string, unknown>): Record<string, unknown> {
	return body.transaction as Record<string, unknown>;
}

function getOperations(body: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
	return getTransaction(body).operations as Array<[string, Record<string, unknown>]>;
}

function getCustomJsonBody(body: Record<string, unknown>): Record<string, unknown> {
	const operations = getOperations(body);
	const lastOperation = operations[operations.length - 1];
	if (!lastOperation) {
		throw new Error("Expected custom_json operation");
	}
	return lastOperation[1];
}

function setCustomJsonPayload(body: Record<string, unknown>, payload: unknown): void {
	getCustomJsonBody(body).json = JSON.stringify(payload);
}

function getTransactionExpiration(body: Record<string, unknown>): string {
	const expiration = getTransaction(body).expiration;
	if (typeof expiration !== "string") {
		throw new Error("Expected transaction expiration string");
	}
	return expiration;
}

function assertRejected(result: MultisigResponse, expectedCode: MultisigErrorCode) {
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.code).toBe(expectedCode);
	}
}

// ============ TESTS ============

describe("Multisig service (regression)", () => {
	beforeAll(async () => {
		await sql.unsafe(`
			DROP TABLE IF EXISTS nft_loans, nft_allowances, collection_allowances,
				data_operators, orphaned_buys, invalid_operations, owner_nft_counts,
				collection_stats, burned_nfts, nfts, collections, sync_state CASCADE
		`);
		await sql.unsafe("DROP TYPE IF EXISTS nft_kind, nft_status CASCADE");
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

	// ─── non-transferable rejection ────────────────────

	describe("non-transferable collection guards", () => {
		test("rejects co-sign for non-transferable collection", async () => {
			const colId = await seedCollection("Locked Col", "LOCKED", false);
			await seedMint("seed_locked1", colId);

			const { listingId, listTxId } = await forceListViaSql("seed_locked1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_locked1",
				listingId,
				listTxId,
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			assertRejected(result, "NFT_NOT_TRANSFERABLE");
			if (!result.ok) {
				expect(result.message).toContain("not transferable");
			}
		});

		test("rejects co-sign for non-transferable even with royalties", async () => {
			const colId = await seedCollection("Locked Roy", "LOCKROY", false, 10);
			await seedMint("seed_locked_roy1", colId);

			const { listingId, listTxId } = await forceListViaSql("seed_locked_roy1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_locked_roy1",
				listingId,
				listTxId,
				seller: "alice",
				royaltyPct: 10,
				royaltyRecipient: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			assertRejected(result, "NFT_NOT_TRANSFERABLE");
		});
	});

	// ─── NFT state guards ──────────────────────────────

	describe("NFT state validation", () => {
		test("rejects co-sign for non-existent NFT", async () => {
			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "nft_ghost",
				listingId: "list_fake",
				listTxId: "tx_fake",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NFT_NOT_FOUND");
		});

		test("rejects co-sign for unlisted NFT", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId: "list_fake",
				listTxId: "tx_fake",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NFT_NOT_LISTED");
		});

		test("rejects co-sign when buyer is owner", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "alice",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "CANNOT_BUY_OWN");
		});

		test("rejects co-sign for expired listing", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);

			// Force-list with past expiry
			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = 'list_expired',
					listing_tx_id = 'tx_expired',
					listing_price = 10,
					listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = 'seed_test1'
			`;

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId: "list_expired",
				listTxId: "tx_expired",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NFT_EXPIRED_LISTING");
		});
	});

	// ─── request shape guards ──────────────────────────

	describe("request shape validation", () => {
		test("rejects missing buyer field", async () => {
			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId: "list_1",
				listTxId: "tx_1",
				seller: "alice",
			});
			delete (body as Record<string, unknown>).buyer;

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects invalid buyer username", async () => {
			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId: "list_1",
				listTxId: "tx_1",
				seller: "alice",
			});
			(body as Record<string, unknown>).buyer = "A";

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects missing transaction field", async () => {
			const body = { buyer: "bob", nftId: "seed_test1", listingId: "list_1", listTxId: "tx_1" };

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects non-object transaction field", async () => {
			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId: "list_1",
				listTxId: "tx_1",
				seller: "alice",
			});
			body.transaction = "not-an-object";

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects non-object request body", async () => {
			const result = await processMultisigRequest("not-an-object", sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects null request body", async () => {
			const result = await processMultisigRequest(null, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});
	});

	// ─── transaction structure guards ──────────────────

	describe("transaction structure validation", () => {
		test("rejects wrong node account in custom_json", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			// Tamper: wrong required_auths in custom_json
			const tx = body.transaction as Record<string, unknown>;
			const ops = tx.operations as Array<[string, Record<string, unknown>]>;
			const lastOp = ops[ops.length - 1]!;
			(lastOp[1] as Record<string, unknown>).required_auths = ["impostor"];

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NODE_ACCOUNT_MISMATCH");
		});

		test("rejects wrong protocol ID in custom_json", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			const tx = body.transaction as Record<string, unknown>;
			const ops = tx.operations as Array<[string, Record<string, unknown>]>;
			const lastOp = ops[ops.length - 1]!;
			(lastOp[1] as Record<string, unknown>).id = "wrong_protocol";

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects transfer from non-buyer account", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			// Tamper: change transfer.from to someone else
			const tx = body.transaction as Record<string, unknown>;
			const ops = tx.operations as Array<[string, Record<string, unknown>]>;
			(ops[0]![1] as Record<string, unknown>).from = "charlie";

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "MISSING_BUYER_AUTH");
		});

		test("rejects transfer operation with invalid shape", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			getOperations(body)[0]![1].amount = 50;

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects non-empty signatures array", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			(body.transaction as Record<string, unknown>).signatures = ["fake_sig"];

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
		});

		test("rejects expiration too soon", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				seller: "alice",
				expirationOffsetMs: 5_000, // 5s < 30s minimum
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
			if (!result.ok) {
				expect(result.message).toContain("expires too soon");
			}
		});

		test("rejects expiration too far in the future", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				seller: "alice",
				expirationOffsetMs: 300_000, // 5min > 120s maximum
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_TX_STRUCTURE");
			if (!result.ok) {
				expect(result.message).toContain("too far in the future");
			}
		});
	});

	// ─── payload data guards ───────────────────────────

	describe("payload data validation", () => {
		test("rejects malformed custom_json JSON", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			getCustomJsonBody(body).json = "{";

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects parsed payload that is not an object", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			getCustomJsonBody(body).json = JSON.stringify(["not-an-object"]);

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects payload action different from buy", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: "list",
				data: { nftId: "seed_test1", txId: nftTxId, listingId, listTxId },
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects payload with invalid data object", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: ACTION_BUY,
				data: null,
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects listingId mismatch between request and DB", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			await listNft("seed_test1");

			// Use wrong listingId in request (passes structure, fails at DB match)
			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId: "list_wrong",
				listTxId: "tx_wrong",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("listingId mismatch");
			}
		});

		test("rejects listTxId mismatch between request and DB", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId: "tx_wrong",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("listTxId mismatch");
			}
		});

		test("rejects payload nftId mismatch", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: ACTION_BUY,
				data: { nftId: "seed_wrong", txId: nftTxId, listingId, listTxId },
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload nftId mismatch");
			}
		});

		test("rejects payload txId mismatch", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: ACTION_BUY,
				data: { nftId: "seed_test1", txId: "tx_wrong", listingId, listTxId },
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload txId mismatch");
			}
		});

		test("rejects payload listingId mismatch", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: ACTION_BUY,
				data: { nftId: "seed_test1", txId: nftTxId, listingId: "list_wrong", listTxId },
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload listingId mismatch");
			}
		});

		test("rejects payload listTxId mismatch", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: ACTION_BUY,
				data: { nftId: "seed_test1", txId: nftTxId, listingId, listTxId: "tx_wrong" },
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload listTxId mismatch");
			}
		});
	});

	// ─── payment split guards ──────────────────────────

	describe("payment split validation", () => {
		test("rejects wrong payment amount", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			// Build request with correct IDs but tamper the transfer amount
			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			// Tamper: change seller payment amount
			const tx = body.transaction as Record<string, unknown>;
			const ops = tx.operations as Array<[string, Record<string, unknown>]>;
			(ops[0]![1] as Record<string, unknown>).amount = "50.000 HIVE";

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PAYMENT_SPLIT");
		});

		test("rejects extra transfer operations", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			// Inject an extra transfer before custom_json
			const tx = body.transaction as Record<string, unknown>;
			const ops = tx.operations as Array<[string, Record<string, unknown>]>;
			const customJson = ops.pop()!;
			ops.push(["transfer", { from: "bob", to: "eve", amount: "1.000 HIVE", memo: "" }]);
			ops.push(customJson);

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PAYMENT_SPLIT");
		});
	});

	describe("successful signing", () => {
		test("returns signature and digest for a valid multisig request", async () => {
			const colId = await seedCollection();
			await seedMint("seed_test1", colId);
			const { listingId, listTxId, nftTxId } = await listNft("seed_test1");

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "seed_test1",
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.signature).toBe("mock_signature");
				expect(result.digest).toMatch(/^[0-9a-f]{40}$/);
				expect(result.expiration).toBe(getTransactionExpiration(body));
			}
		});
	});
});

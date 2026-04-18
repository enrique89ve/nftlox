/**
 * Regression tests for the multisig co-signing service.
 *
 * Covers NFT state validation (non-transferable, not-listed, expired, buy-own),
 * request shape validation, transaction structure, and payment split guards.
 *
 * Uses real DB (same pattern as handlers.test.ts) — no mocks.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { sql, withTransaction } from "@/db/client.ts";
import { processMultisigRequest } from "@/api/services/multisig-service.ts";

// Mock beekeeper signer — rejection tests never reach signing
mock.module("@/api/services/beekeeper-signer.ts", () => ({
	signWithBeekeeper: () => "mock_signature",
	isBeekeeperReady: () => true,
	getSignerPublicKey: () => "STM_mock_pubkey",
}));
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { config } from "@/config.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
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
	generateDeterministicSeedId,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_VERSION,
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
		version: PROTOCOL_VERSION,
		data,
		pairedTransfers,
	};
}

async function cleanDb() {
	await sql`DELETE FROM multisig_locks`;
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

async function seedCollection(
	name = "Multisig Test",
	symbol = "MSTEST",
	transferable = true,
	royaltyPct = 0,
	creator = "alice",
): Promise<string> {
	const id = await generateDeterministicCollectionId(creator, name, symbol);
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const pairedTransfers = [
		{ from: creator, to: NODE_ACCOUNT, amount: feeAmount, currency: "HBD", memo: "" },
	];
	const rules: Record<string, unknown> = { transferable, burnable: true, royaltyPct };
	if (royaltyPct > 0) rules.royaltyRecipient = creator;
	const op = makeOp(
		ACTION_CREATE_COLLECTION,
		{
			id,
			name,
			symbol,
			totalPotential: 1000,
			metadata: { description: `Test collection ${name}`, image: "https://example.com/img.png" },
			rules,
		},
		NODE_ACCOUNT,
		pairedTransfers,
	);
	await withTransaction((txn) => handleCreateCollection(op, txn));
	return id;
}

async function seedMint(artId: string, collectionId: string): Promise<string> {
	const nftId = await generateDeterministicSeedId(collectionId, artId);
	const op = makeOp(ACTION_MINT, {
		id: nftId,
		artId,
		collectionId,
		edition: 1,
		owner: "alice",
		maxSupply: 10,
		metadata: { name: `NFT ${artId}`, imageUrl: "https://example.com/nft.png", imageHash: "img_abc" },
	});
	await withTransaction((txn) => handleMint(op, txn));
	return nftId;
}

async function seedInstance(seedId: string): Promise<string> {
	const [seed] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
	await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
		items: [{ seedId, quantity: 1, seedTxId: seed!.tx_id }],
	}), txn));
	const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
	return inst!.id as string;
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
	await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));
	const [nft] = await sql`SELECT listing_id, listing_tx_id, created_tx_id AS tx_id FROM nfts WHERE id = ${nftId}`;
	return { listingId: nft!.listing_id as string, listTxId: nft!.listing_tx_id as string, nftTxId: nft!.tx_id as string };
}

async function seedListedInstance(): Promise<Readonly<{
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly nftTxId: string;
}>> {
	const colId = await seedCollection();
	const seedId = await seedMint("test1", colId);
	const nftId = await seedInstance(seedId);
	const listing = await listNft(nftId);
	return { nftId, ...listing };
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

function makeProtocolPayload(
	action: string,
	data: unknown,
	overrides: Partial<Readonly<{ protocol: string; version: string }>> = {},
): Record<string, unknown> {
	return {
		protocol: overrides.protocol ?? PROTOCOL_ID,
		version: overrides.version ?? PROTOCOL_VERSION,
		action,
		data,
	};
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
	currency?: "HIVE" | "HBD";
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
		json: JSON.stringify(makeProtocolPayload(
			ACTION_BUY,
			{ nftId, txId: nftTxId, listingId, listTxId },
		)),
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

	// ─── non-transferable rejection ────────────────────

	describe("non-transferable collection guards", () => {
		test("rejects co-sign for non-transferable collection", async () => {
			const colId = await seedCollection("Locked Col", "LOCKED", false);
			const seedId = await seedMint("locked1", colId);
			const nftId = await seedInstance(seedId);

			const { listingId, listTxId } = await forceListViaSql(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			assertRejected(result, "NFT_NOT_TRANSFERABLE");
			if (!result.ok) {
				expect(result.message).toContain("cannot be transferred");
			}
		});

		test("rejects co-sign for non-transferable even with royalties", async () => {
			const colId = await seedCollection("Locked Roy", "LOCKROY", false, 10);
			const seedId = await seedMint("locked_roy1", colId);
			const nftId = await seedInstance(seedId);

			const { listingId, listTxId } = await forceListViaSql(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: seedId,
				listingId: "list_fake",
				listTxId: "tx_fake",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NFT_NOT_LISTED");
		});

		test("rejects co-sign when buyer is owner", async () => {
			const colId = await seedCollection();
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId, nftTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "alice",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);

			// Force-list with past expiry
			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = 'list_expired',
					listing_tx_id = 'tx_expired',
					listing_price = 10,
					listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${nftId}
			`;

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId: "list_expired",
				listTxId: "tx_expired",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NFT_EXPIRED_LISTING");
		});

		test("rejects co-sign for legacy listed seed", async () => {
			const colId = await seedCollection();
			const seedId = await seedMint("test1", colId);
			const { listingId, listTxId } = await forceListViaSql(seedId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: seedId,
				listingId,
				listTxId,
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "NFT_NOT_INSTANCE");
			if (!result.ok) {
				expect(result.message).toContain("Only instances can be bought");
			}
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId, nftTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId, nftTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId, nftTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId, nftTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId, nftTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const seedId = await seedMint("test1", colId);
			const nftId = await seedInstance(seedId);
			const { listingId, listTxId } = await listNft(nftId);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			getCustomJsonBody(body).json = JSON.stringify(["not-an-object"]);

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects legacy action/data payload before signing", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, {
				action: ACTION_BUY,
				data: { nftId, txId: nftTxId, listingId, listTxId },
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload protocol");
			}
		});

		test("rejects protocol mismatch inside payload", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_BUY,
				{ nftId, txId: nftTxId, listingId, listTxId },
				{ protocol: "nftlox_evil" },
			));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload protocol");
			}
		});

		test("rejects payload version below protocol minimum", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_BUY,
				{ nftId, txId: nftTxId, listingId, listTxId },
				{ version: "0.0.1" },
			));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("below minimum");
			}
		});

		test("rejects payload action different from buy", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_LIST,
				{ nftId, txId: nftTxId, listingId, listTxId },
			));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects payload with invalid data object", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(ACTION_BUY, null));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
		});

		test("rejects listingId mismatch between request and DB", async () => {
			const { nftId } = await seedListedInstance();

			// Use wrong listingId in request (passes structure, fails at DB match)
			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId: "list_wrong",
				listTxId: "tx_wrong",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("listingId does not match current listing");
			}
		});

		test("rejects listTxId mismatch between request and DB", async () => {
			const { nftId, listingId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId: "tx_wrong",
				seller: "alice",
			});

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("listTxId does not match current listing");
			}
		});

		test("rejects payload nftId mismatch", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_BUY,
				{ nftId: "seed_wrong", txId: nftTxId, listingId, listTxId },
			));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload nftId mismatch");
			}
		});

		test("rejects payload txId mismatch", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_BUY,
				{ nftId, txId: "tx_wrong", listingId, listTxId },
			));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload txId mismatch");
			}
		});

		test("rejects payload listingId mismatch", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_BUY,
				{ nftId, txId: nftTxId, listingId: "list_wrong", listTxId },
			));

			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);
			assertRejected(result, "INVALID_PROTOCOL_PAYLOAD");
			if (!result.ok) {
				expect(result.message).toContain("Payload listingId mismatch");
			}
		});

		test("rejects payload listTxId mismatch", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
				listingId,
				listTxId,
				nftTxId,
				seller: "alice",
			});

			setCustomJsonPayload(body, makeProtocolPayload(
				ACTION_BUY,
				{ nftId, txId: nftTxId, listingId, listTxId: "tx_wrong" },
			));

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
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			// Build request with correct IDs but tamper the transfer amount
			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();

			const body = makeMultisigBody({
				buyer: "bob",
				nftId,
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

	// Lag gate: blocks signing when the indexer is more than MULTISIG_LAG_MAX_BLOCKS
	// behind Hive's observed HEAD. The service compares sync_state.hive_head_block
	// (updated every cycle from the chain consensus fetch) against sync_state.last_block
	// (advanced after each processed block). Without this gate, the signing node could
	// co-sign a buy against NFT state that has since changed on-chain.
	describe("lag gate", () => {
		async function setSyncState(lastBlock: number, hiveHeadBlock: number) {
			await sql`
				UPDATE sync_state
				SET last_block = ${lastBlock}, hive_head_block = ${hiveHeadBlock}
				WHERE id = 1
			`;
		}

		// Reset sync_state after each test so other describe blocks see defaults.
		beforeEach(async () => {
			await setSyncState(0, 0);
		});

		test("lag EQUAL to the max threshold passes through", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();
			// lag = 3, MULTISIG_LAG_MAX_BLOCKS = 3 → 3 > 3 is false → pass
			await setSyncState(1000, 1003);

			const body = makeMultisigBody({
				buyer: "bob", nftId, listingId, listTxId, nftTxId, seller: "alice",
			});
			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			expect(result.ok).toBe(true);
		});

		test("lag ABOVE the max threshold returns INDEXER_LAGGED with retryAfterMs", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();
			// lag = 4, MULTISIG_LAG_MAX_BLOCKS = 3 → reject
			await setSyncState(1000, 1004);

			const body = makeMultisigBody({
				buyer: "bob", nftId, listingId, listTxId, nftTxId, seller: "alice",
			});
			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			assertRejected(result, "INDEXER_LAGGED");
			if (!result.ok) {
				expect(result.message).toContain("blocks behind");
				expect(result.retryAfterMs).toBeGreaterThan(0);
			}
		});

		test("large lag produces a proportionally larger retryAfterMs", async () => {
			const { nftId, listingId, listTxId, nftTxId } = await seedListedInstance();
			await setSyncState(1000, 1050); // 50 blocks behind

			const body = makeMultisigBody({
				buyer: "bob", nftId, listingId, listTxId, nftTxId, seller: "alice",
			});
			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			assertRejected(result, "INDEXER_LAGGED");
			if (!result.ok) {
				// ≥ (deficit 48) * 3000ms = 144_000ms
				expect(result.retryAfterMs).toBeGreaterThanOrEqual(144_000);
			}
		});

		test("lag gate fires BEFORE NFT lookup — ghost NFT still returns INDEXER_LAGGED", async () => {
			// Even though the NFT id is bogus, the lag check short-circuits first.
			await setSyncState(1000, 1050);

			const body = makeMultisigBody({
				buyer: "bob",
				nftId: "nft_does_not_exist",
				listingId: "listing_ghost",
				listTxId: "tx_ghost",
				seller: "alice",
			});
			const result = await processMultisigRequest(body, sql, NODE_ACCOUNT, PROTOCOL_ID);

			assertRejected(result, "INDEXER_LAGGED");
		});
	});
});

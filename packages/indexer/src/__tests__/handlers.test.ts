import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, withTransaction, type Queryable } from "@/db/client.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleArchiveCollection } from "@/processor/handlers/core/archive-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleUnlist } from "@/processor/handlers/marketplace/unlist.ts";
import { handleBuy } from "@/processor/handlers/marketplace/buy.ts";
import { config } from "@/config.ts";
import { handleNftApprove } from "@/processor/handlers/allowances/nft-approve.ts";
import { handleNftApproveAll } from "@/processor/handlers/allowances/nft-approve-all.ts";
import { handleNftTransferFrom } from "@/processor/handlers/allowances/nft-transfer-from.ts";
import { handleNftLend } from "@/processor/handlers/lending/nft-lend.ts";
import { handleNftReturn } from "@/processor/handlers/lending/nft-return.ts";
import { handleDataOperatorApprove } from "@/processor/handlers/allowances/data-operator-approve.ts";
import { handleSetDataFrom } from "@/processor/handlers/allowances/set-data-from.ts";
import { getCollectionStats, listCollections } from "@/db/queries/collections.ts";
import { cleanupInvalidMarketplaceListings, queryNfts } from "@/db/queries/nfts.ts";
import { materializePendingUnlists } from "@/db/queries/nft-mutations.ts";
import { getProtocolStats } from "@/db/queries/stats.ts";
import { multisigRoutes } from "@/api/routes/multisig.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ACTION_BUY,
	calculatePaymentSplit,
	ACTIVE_AUTH_ACTIONS,
	generateListingNonce,
	generateListingId,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	PROTOCOL_COLLECTION_FEE_HBD,
	UNLIST_DELAY_BLOCKS,
} from "@/protocol/index.ts";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);

// Canonical collection ID for alice + "Test Collection" + "TEST"
let COL_ID: string;

// Canonical seed IDs (precomputed in beforeAll) for the fixture artIds
// reused across many tests. One-off mints compute ids inline via canonicalSeedId().
// Empty-string initializer keeps TypeScript's definite-assignment checker happy;
// both vars are set before any test runs.
let SEED_TEST1 = "";
let SEED_TEST2 = "";

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
		operationId: `op_${id}`,
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

/**
 * Builds a create_collection op with the node-account signer and a paired fee transfer
 * from the given creator. All tests must use this helper — `handleCreateCollection`
 * now enforces signer == config.hiveAccount and derives the creator from the fee transfer.
 */
function makeCreateCollectionOp(
	data: Record<string, unknown>,
	creator = "alice",
): ParsedOperation {
	const feeAmount = parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
	const pairedTransfers = [
		{ from: creator, to: config.hiveAccount, amount: feeAmount, currency: "HBD", memo: "" },
	];
	return makeOp(ACTION_CREATE_COLLECTION, data, config.hiveAccount, pairedTransfers);
}

async function seedCollection(txn?: Queryable): Promise<void> {
	const op = makeCreateCollectionOp({
		id: COL_ID,
		name: "Test Collection",
		symbol: "TEST",
		totalPotential: 1000,
		metadata: { description: "A test collection", image: "https://example.com/img.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 5, royaltyRecipient: "alice" },
	});
	if (txn) {
		await handleCreateCollection(op, txn);
		return;
	}
	await withTransaction(async (t) => {
		await handleCreateCollection(op, t);
	});
}

async function makeCanonicalCollection(
	signer: string,
	name: string,
	symbol: string,
	overrides: Record<string, unknown> = {},
): Promise<{ id: string; data: Record<string, unknown> }> {
	const id = await generateDeterministicCollectionId(signer, name, symbol);
	return {
		id,
		data: {
			id,
			name,
			symbol,
			totalPotential: 100,
			metadata: { description: "Test", image: "https://example.com/img.png" },
			rules: { transferable: true, burnable: true, royaltyPct: 0 },
			...overrides,
		},
	};
}

/**
 * Computes the canonical seedId for a given artId + collectionId. Mirrors the
 * indexer's canonical enforcement so fixtures can be built without hard-coding
 * hash outputs — simply pick a memorable artId and the helper does the rest.
 */
async function canonicalSeedId(artId: string, collectionId: string = COL_ID): Promise<string> {
	return generateDeterministicSeedId(collectionId, artId);
}

/**
 * Builds an ACTION_MINT op with a canonically-computed seedId + artId.
 * Callers pass the artId (human-readable label) and the helper guarantees:
 *   - `id` is the canonical hash — can never be accidentally non-canonical
 *   - `artId` is always forwarded (required by handleMint after canonical extraction)
 *   - `collectionId` defaults to COL_ID but respects overrides
 *
 * `overrides` can provide `collectionId`, `owner`, `maxSupply`, `metadata`, `nftType`, etc.
 * It cannot override `id` or `artId` — those are set last to preserve invariants.
 */
async function makeMintOp(
	artId: string,
	overrides: Record<string, unknown> = {},
	signer = "alice",
): Promise<{ op: ParsedOperation; id: string }> {
	const collectionId = (overrides.collectionId as string) ?? COL_ID;
	const id = await generateDeterministicSeedId(collectionId, artId);
	const data: Record<string, unknown> = {
		collectionId,
		edition: 1,
		owner: "alice",
		maxSupply: 10,
		metadata: { name: `Seed ${artId}`, imageUrl: "https://example.com/nft.png", imageHash: `img_${artId}` },
		...overrides,
		id,
		artId,
	};
	return { op: makeOp(ACTION_MINT, data, signer), id };
}

async function seedMint(txn?: Queryable): Promise<void> {
	const { op } = await makeMintOp("test1", {
		maxSupply: 10,
		metadata: { name: "Test Seed", imageUrl: "https://example.com/nft.png", imageHash: "img_abc" },
	});
	if (txn) {
		await handleMint(op, txn);
		return;
	}
	await withTransaction(async (t) => {
		await handleMint(op, t);
	});
}

/**
 * Creates an instance from SEED_TEST1 via bulk_distribute.
 * Returns the deterministic instance ID (nft_<seedSuffix>_1_...).
 * Requires seedCollection() + seedMint() to have been called first.
 */
async function seedInstance(txn?: Queryable): Promise<string> {
	return seedInstanceFrom(SEED_TEST1, txn);
}

async function seedInstanceFrom(seedId: string, txn?: Queryable): Promise<string> {
	const seedTxId = await getSeedTxId(seedId);
	const op = makeOp(ACTION_BULK_DISTRIBUTE, {
		items: [{ seedId, quantity: 1, seedTxId }],
	});
	if (txn) {
		await handleBulkDistribute(op, txn);
		const [inst] = await txn`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
		return inst!.id as string;
	}
	return withTransaction(async (t) => {
		await handleBulkDistribute(op, t);
		const [inst] = await t`SELECT id FROM nfts WHERE seed_id = ${seedId} LIMIT 1`;
		return inst!.id as string;
	});
}

async function makeBulkItem(seedId: string, quantity: number, seedTxId?: string) {
	const txId = seedTxId ?? await getSeedTxId(seedId);
	return { seedId, quantity, seedTxId: txId };
}

async function getSeedTxId(seedId: string): Promise<string> {
	const [row] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${seedId}`;
	return row!.tx_id as string;
}

async function makeListData(params: {
	nftId: string;
	owner?: string;
	priceAmount?: string;
	priceCurrency?: string;
	marketplace?: string;
	expiresAt?: number;
}): Promise<Record<string, unknown>> {
	const nonce = generateListingNonce();
	const amount = params.priceAmount ?? "10.000";
	const currency = params.priceCurrency ?? "HIVE";
	const marketplace = params.marketplace ?? "";
	const expiresAt = params.expiresAt ?? 0;

	const listingId = await generateListingId({
		nftId: params.nftId,
		owner: params.owner ?? "alice",
		marketplace,
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
		...(marketplace ? { marketplace } : {}),
		...(expiresAt ? { expiresAt } : {}),
	};
}

describe("Handlers (integration)", () => {
	beforeAll(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", "Test Collection", "TEST");
		SEED_TEST1 = await canonicalSeedId("test1");
		SEED_TEST2 = await canonicalSeedId("test2");
		// Drift-immune wipe: nuke the whole `public` schema instead of a
		// hand-maintained DROP TABLE list. Previous list-based wipes silently
		// skipped newer tables (schema_versions, sales, confirmed_operations,
		// etc.), leaving stale structure that stripped FK constraints when
		// CASCADE propagated. Testnet-only — never run this on a live DB.
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

	// ─── create_collection ──────────────────────────

	describe("create_collection", () => {
		test("creates a collection", async () => {
			await seedCollection();
			const [row] = await sql`SELECT * FROM collections WHERE id = ${COL_ID}`;
			expect(row).toBeDefined();
			expect(row!.name).toBe("Test Collection");
			expect(row!.symbol).toBe("TEST");
			expect(row!.creator).toBe("alice");
		});

		test("duplicate collection is idempotent no-op", async () => {
			await seedCollection();
			await expect(seedCollection()).resolves.toBeUndefined();
		});

		test("rejects non-canonical collectionId", async () => {
			const op = makeCreateCollectionOp({
				id: "col_fake_id_12345",
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, royaltyPct: 0 },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("Non-canonical collectionId");
		});

		test("ignores payload-only originDna on collection creation", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				originDna: "FAKE_ORIGIN_DNA",
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, royaltyPct: 0 },
			});
			await withTransaction((txn) => handleCreateCollection(op, txn));
			const [row] = await sql`SELECT id, name FROM collections WHERE id = ${COL_ID}`;
			expect(row).toMatchObject({ id: COL_ID, name: "Test Collection" });
		});

		test("rejects missing metadata", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				rules: { transferable: true, burnable: true, royaltyPct: 0 },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("metadata");
		});

		test("rejects missing metadata.description", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, royaltyPct: 0 },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("metadata.description");
		});

		test("rejects missing rules", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("rules");
		});

		test("rejects missing rules.transferable", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { burnable: true, royaltyPct: 0 },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("rules.transferable");
		});

		test("rejects royaltyPct out of range", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, royaltyPct: 60 },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("royaltyPct");
		});

		test("rejects negative totalPotential", async () => {
			const op = makeCreateCollectionOp({
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: -5,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, royaltyPct: 0 },
			});
			await expect(withTransaction((txn) => handleCreateCollection(op, txn))).rejects.toThrow("totalPotential");
		});
	});

	// ─── archive_collection ─────────────────────────

	describe("archive_collection", () => {
		test("archives an empty collection, clears collection-scoped permissions, and hides it from lists", async () => {
			await seedCollection();
			await seedMint();

			// approveAll requires ownership — alice has SEED_TEST1
			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "bob",
				collectionId: COL_ID,
				approved: true,
			}), txn));
			await withTransaction((txn) => handleDataOperatorApprove(makeOp(ACTION_DATA_OPERATOR_APPROVE, {
				collectionId: COL_ID,
				operator: "carol",
				approved: true,
			}), txn));

			// Delete the NFT directly so collection appears empty for archive
			await sql`DELETE FROM nfts WHERE collection_id = ${COL_ID}`;
			await sql`DELETE FROM owner_nft_counts`;
			await sql`DELETE FROM collection_stats WHERE collection_id = ${COL_ID}`;

			await withTransaction((txn) => handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
				collectionId: COL_ID,
			}), txn));

			// Collection should be hard-deleted from collections table
			const [collection] = await sql`SELECT 1 FROM collections WHERE id = ${COL_ID}`;
			expect(collection).toBeUndefined();

			// Minimal audit record should exist in archived_collections
			const [archived] = await sql`SELECT id, creator, tx_id FROM archived_collections WHERE id = ${COL_ID}`;
			expect(archived).toBeDefined();
			expect(archived!.id).toBe(COL_ID);
			expect(archived!.creator).toBe("alice");
			expect(archived!.tx_id).toBeDefined();

			// Cascaded child tables should also be gone
			const [allowances] = await sql`
				SELECT COUNT(*)::int AS count FROM collection_allowances WHERE collection_id = ${COL_ID}
			`;
			const [operators] = await sql`
				SELECT COUNT(*)::int AS count FROM data_operators WHERE collection_id = ${COL_ID}
			`;
			const [stats] = await sql`
				SELECT 1 FROM collection_stats WHERE collection_id = ${COL_ID}
			`;
			expect(Number(allowances!.count)).toBe(0);
			expect(Number(operators!.count)).toBe(0);
			expect(stats).toBeUndefined();

			const visibleCollections = await listCollections();
			expect(visibleCollections.some((row) => row.id === COL_ID)).toBe(false);
		});

		test("rejects archive when NFTs already exist", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				withTransaction((txn) => handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
					collectionId: COL_ID,
				}), txn)),
			).rejects.toThrow("NFTs still exist");
		});

		test("rejects archive from non-creator signer", async () => {
			await seedCollection();

			await expect(
				withTransaction((txn) => handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
					collectionId: COL_ID,
				}, "eve"), txn)),
			).rejects.toThrow("is not creator");
		});

		test("mint rejects deleted collection", async () => {
			await seedCollection();
			await withTransaction((txn) => handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
				collectionId: COL_ID,
			}), txn));

			const { op: afterArchiveOp } = await makeMintOp("after_archive", {
				metadata: { name: "After Archive" },
			});
			await expect(
				withTransaction((txn) => handleMint(afterArchiveOp, txn)),
			).rejects.toThrow("not found");
		});

	});

	// ─── mint ───────────────────────────────────────

	describe("mint", () => {
		test("mints a seed NFT", async () => {
			await seedCollection();
			await seedMint();
			const [nft] = await sql`SELECT * FROM nfts WHERE id = ${SEED_TEST1}`;
			expect(nft).toBeDefined();
			expect(nft!.nft_type).toBe("seed");
			expect(nft!.owner).toBe("alice");
			expect(nft!.max_supply).toBe(10);
		});

		test("rejects mint without collection", async () => {
			const { op } = await makeMintOp("orphan", {
				collectionId: "col_nonexistent",
				metadata: { name: "Test" },
			});
			await expect(withTransaction((txn) => handleMint(op, txn))).rejects.toThrow("Collection not found");
		});

		test("duplicate mint is idempotent no-op", async () => {
			await seedCollection();
			await seedMint();
			await expect(seedMint()).resolves.toBeUndefined();
		});

		test("always computes DNA internally, ignoring user-supplied values", async () => {
			await seedCollection();
			const { op, id: dnaSeedId } = await makeMintOp("dna_test", {
				originDna: "FAKE_ORIGIN_DNA",
				instanceDna: "FAKE_INSTANCE_DNA",
				uniqueAccessKey: "FAKEKEY1",
				metadata: { name: "DNA Test", imageHash: "hash_abc" },
			});
			await withTransaction((txn) => handleMint(op, txn));

			const [nft] = await sql`SELECT origin_dna, instance_dna FROM nfts WHERE id = ${dnaSeedId}`;
			expect(nft).toBeDefined();
			// Must NOT be the fake values
			expect(nft!.origin_dna).not.toBe("FAKE_ORIGIN_DNA");
			expect(nft!.instance_dna).not.toBe("FAKE_INSTANCE_DNA");
			// Must be non-null (computed)
			expect(nft!.origin_dna).toBeTruthy();
			expect(nft!.instance_dna).toBeTruthy();
		});

		test("mint DNA is deterministic across replays", async () => {
			await seedCollection();

			const replayOverrides = { metadata: { name: "Replay", imageHash: "hash_xyz" } };
			const { op: op1, id: replayId } = await makeMintOp("replay_dna", replayOverrides);
			// Force same txId for both calls
			(op1 as any).txId = "tx_fixed_replay";
			await withTransaction((txn) => handleMint(op1, txn));

			const [nft1] = await sql`SELECT instance_dna FROM nfts WHERE id = ${replayId}`;

			// Clean and replay with same txId
			await sql`DELETE FROM nfts WHERE id = ${replayId}`;
			const { op: op2 } = await makeMintOp("replay_dna", replayOverrides);
			(op2 as any).txId = "tx_fixed_replay";
			await withTransaction((txn) => handleMint(op2, txn));

			const [nft2] = await sql`SELECT instance_dna FROM nfts WHERE id = ${replayId}`;
			expect(nft1!.instance_dna).toBe(nft2!.instance_dna);
		});

		test("rejects non-canonical seedId (e.g. instance-shaped id)", async () => {
			await seedCollection();

			// Payload supplies a non-canonical id — canonical enforcement fires
			// before resolveNftType, so this path now rejects on hash mismatch.
			const instOp = makeOp(ACTION_MINT, {
				id: "nft_bbb_1_ccc",
				artId: "canonical_mismatch",
				collectionId: COL_ID,
				metadata: { name: "Instance" },
			});
			await expect(withTransaction((txn) => handleMint(instOp, txn))).rejects.toThrow(
				"Non-canonical seedId",
			);
		});

		test("rejects explicit nftType instance", async () => {
			await seedCollection();

			const { op } = await makeMintOp("explicit_inst", {
				nftType: "instance",
				metadata: { name: "Fake Instance" },
			});
			await expect(withTransaction((txn) => handleMint(op, txn))).rejects.toThrow(
				"Only seeds can be minted directly",
			);
		});

	});

	// ─── bulk_distribute ────────────────────────────

	describe("bulk_distribute", () => {
		test("distributes instances from seed", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 3)],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = ${SEED_TEST1} ORDER BY instance_number`;
			expect(instances.length).toBe(3);
			expect(instances[0]!.owner).toBe("bob");
			expect(instances[0]!.nft_type).toBe("instance");
			expect(instances[2]!.instance_number).toBe(3);

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = ${SEED_TEST1}`;
			expect(seed!.distributed).toBe(3);
		});

		test("distributed instances always have non-null DNA and access keys", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 2)],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const instances = await sql`
				SELECT origin_dna, instance_dna
				FROM nfts WHERE seed_id = ${SEED_TEST1} ORDER BY instance_number
			`;
			for (const inst of instances) {
				expect(inst.origin_dna).toBeTruthy();
				expect(inst.instance_dna).toBeTruthy();
			}
			// Different instances should have different DNA
			expect(instances[0]!.instance_dna).not.toBe(instances[1]!.instance_dna);
		});

		test("rejects distribute by non-owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 1)],
			}, "eve");
			await expect(withTransaction((txn) => handleBulkDistribute(op, txn))).rejects.toThrow("is not the owner of seed");
		});

		test("rejects distribute over max supply", async () => {
			await seedCollection();

			const { op: mintOp, id: limitedId } = await makeMintOp("limited", {
				maxSupply: 2,
				metadata: { name: "Limited" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(limitedId, 3)],
			});
			await expect(withTransaction((txn) => handleBulkDistribute(op, txn))).rejects.toThrow("insufficient supply");
		});

		test("rejects duplicate seedId in items", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [
					await makeBulkItem(SEED_TEST1, 1),
					await makeBulkItem(SEED_TEST1, 1),
				],
			});
			await expect(withTransaction((txn) => handleBulkDistribute(op, txn))).rejects.toThrow("Duplicate seedId");
		});

		test("rejects invalid seedTxId", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
			});
			await expect(withTransaction((txn) => handleBulkDistribute(op, txn))).rejects.toThrow("Invalid seedTxId");
		});

		test("rejects missing seedTxId", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: SEED_TEST1, quantity: 1 }],
			});
			await expect(withTransaction((txn) => handleBulkDistribute(op, txn))).rejects.toThrow("seedTxId");
		});

		test("idempotent on reprocess (same tx)", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 2)],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			// Reprocess same op — should skip existing, mint 0
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = ${SEED_TEST1}`;
			expect(seed!.distributed).toBe(2); // not 4
		});

		test("defaults to signer when no 'to' provided", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [await makeBulkItem(SEED_TEST1, 1)],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const [inst] = await sql`SELECT owner FROM nfts WHERE seed_id = ${SEED_TEST1}`;
			expect(inst!.owner).toBe("alice");
		});

		test("only owner can distribute — creator without ownership is rejected", async () => {
			await seedCollection(); // creator = alice

			// Mint seed owned by bob (alice is creator, mints for bob)
			const { op: mintOp, id: bobSeedId } = await makeMintOp("bob", {
				owner: "bob",
				maxSupply: 10,
				metadata: { name: "Bob Seed" },
			}, "alice");
			await withTransaction((txn) => handleMint(mintOp, txn));

			// Alice (creator but NOT owner) tries to distribute — must be rejected
			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [await makeBulkItem(bobSeedId, 2)],
			}, "alice");
			await expect(withTransaction((txn) => handleBulkDistribute(op, txn))).rejects.toThrow("is not the owner of seed");

			// Bob (owner) can distribute
			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [await makeBulkItem(bobSeedId, 2)],
			}, "bob");
			await withTransaction((txn) => handleBulkDistribute(op2, txn));

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = ${bobSeedId}`;
			expect(instances.length).toBe(2);
			expect(instances[0]!.owner).toBe("charlie");
		});

		// ─── idempotency tests ─────────────────────

		test("idempotent on reprocess — instances unchanged", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 2)],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = ${SEED_TEST1} ORDER BY instance_number`;
			expect(instances.length).toBe(2); // not 4
			expect(instances[0]!.instance_number).toBe(1);
			expect(instances[1]!.instance_number).toBe(2);
		});

		test("sequential distributes produce sequential instance numbers", async () => {
			await seedCollection();
			await seedMint();

			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 2)],
			});
			await withTransaction((txn) => handleBulkDistribute(op1, txn));

			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [await makeBulkItem(SEED_TEST1, 3)],
			});
			await withTransaction((txn) => handleBulkDistribute(op2, txn));

			const instances = await sql`SELECT instance_number, owner FROM nfts WHERE seed_id = ${SEED_TEST1} ORDER BY instance_number`;
			expect(instances.length).toBe(5);
			expect(instances[0]!.instance_number).toBe(1);
			expect(instances[0]!.owner).toBe("bob");
			expect(instances[4]!.instance_number).toBe(5);
			expect(instances[4]!.owner).toBe("charlie");
		});

		test("partial replay only creates missing instances", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(SEED_TEST1, 3)],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			// Delete one instance to simulate partial state
			await sql`DELETE FROM nfts WHERE instance_number = 2 AND seed_id = ${SEED_TEST1}`;
			await sql`UPDATE nfts SET distributed = distributed - 1 WHERE id = ${SEED_TEST1}`;

			// Replay should recreate only the missing instance
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const instances = await sql`SELECT instance_number FROM nfts WHERE seed_id = ${SEED_TEST1} ORDER BY instance_number`;
			expect(instances.length).toBe(3);
			expect(instances.map(i => i.instance_number)).toEqual([1, 2, 3]);
		});

		test("supply check uses pre-tx distributed count", async () => {
			await seedCollection();

			// Seed with max 3 distributable instances
			const { op: mintOp, id: cappedId } = await makeMintOp("capped", {
				maxSupply: 3,
				metadata: { name: "Capped" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			// Distribute 2
			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(cappedId, 2)],
			});
			await withTransaction((txn) => handleBulkDistribute(op1, txn));

			// Replay of op1 should NOT throw (baseDistributed=0, quantity=2, max=3 — OK)
			await withTransaction((txn) => handleBulkDistribute(op1, txn));

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = ${cappedId}`;
			expect(seed!.distributed).toBe(2);
		});

		test("multi-seed bulk distribute is idempotent", async () => {
			await seedCollection();
			await seedMint(); // SEED_TEST1

			const { op: mintOp2 } = await makeMintOp("test2", {
				maxSupply: 10,
				metadata: { name: "Seed 2" },
			});
			await withTransaction((txn) => handleMint(mintOp2, txn));

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [
					await makeBulkItem(SEED_TEST1, 2),
					await makeBulkItem(SEED_TEST2, 3),
				],
			});
			await withTransaction((txn) => handleBulkDistribute(op, txn));
			await withTransaction((txn) => handleBulkDistribute(op, txn));

			const inst1 = await sql`SELECT * FROM nfts WHERE seed_id = ${SEED_TEST1}`;
			const inst2 = await sql`SELECT * FROM nfts WHERE seed_id = ${SEED_TEST2}`;
			expect(inst1.length).toBe(2);
			expect(inst2.length).toBe(3);

			const [s1] = await sql`SELECT distributed FROM nfts WHERE id = ${SEED_TEST1}`;
			const [s2] = await sql`SELECT distributed FROM nfts WHERE id = ${SEED_TEST2}`;
			expect(s1!.distributed).toBe(2);
			expect(s2!.distributed).toBe(3);
		});

		// ─── concurrency / parallel distribution tests ─

		test("concurrent distributes from same seed maintain correct distributed count", async () => {
			await seedCollection();

			const { op: mintOp, id: concurrentId } = await makeMintOp("concurrent", {
				maxSupply: 20,
				metadata: { name: "Concurrent Seed" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			// 5 different transactions, each distributing 2 instances, run sequentially
			// (simulates blockchain order — ops arrive one after another)
			const testUsers = ["user-aaa", "user-bbb", "user-ccc", "user-ddd", "user-eee"];
			for (let t = 0; t < 5; t++) {
				const op = makeOp(ACTION_BULK_DISTRIBUTE, {
					to: testUsers[t],
					items: [await makeBulkItem(concurrentId, 2)],
				});
				// Override txId to make each unique
				(op as any).txId = `tx_concurrent_${t}`;
				await withTransaction((txn) => handleBulkDistribute(op, txn));
			}

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = ${concurrentId}`;
			expect(seed!.distributed).toBe(10);

			const instances = await sql`
				SELECT instance_number, owner FROM nfts
				WHERE seed_id = ${concurrentId}
				ORDER BY instance_number
			`;
			expect(instances.length).toBe(10);
			// Instance numbers should be 1 through 10 with no gaps
			expect(instances.map(i => i.instance_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			// Each pair belongs to the correct user
			expect(instances[0]!.owner).toBe("user-aaa");
			expect(instances[1]!.owner).toBe("user-aaa");
			expect(instances[8]!.owner).toBe("user-eee");
			expect(instances[9]!.owner).toBe("user-eee");
		});

		test("concurrent distributes respect max supply cap", async () => {
			await seedCollection();

			const { op: mintOp, id: raceId } = await makeMintOp("race", {
				maxSupply: 5,
				metadata: { name: "Race Seed" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			// Distribute 3 first
			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "alice",
				items: [await makeBulkItem(raceId, 3)],
			});
			(op1 as any).txId = "tx_race_1";
			await withTransaction((txn) => handleBulkDistribute(op1, txn));

			// Now try to distribute 3 more — should fail (only 2 remaining)
			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem(raceId, 3)],
			});
			(op2 as any).txId = "tx_race_2";
			await expect(withTransaction((txn) => handleBulkDistribute(op2, txn))).rejects.toThrow("insufficient supply");

			// Distributed counter should still be 3
			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = ${raceId}`;
			expect(seed!.distributed).toBe(3);
		});

		test("concurrent distributes then replay — all idempotent", async () => {
			await seedCollection();

			const { op: mintOp, id: replayMultiId } = await makeMintOp("replay_multi", {
				maxSupply: 10,
				metadata: { name: "Replay Multi" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			const replayUsers = ["user-aaa", "user-bbb", "user-ccc"];
			const bulkItem = await makeBulkItem(replayMultiId, 2);
			const ops = Array.from({ length: 3 }, (_, t) => {
				const op = makeOp(ACTION_BULK_DISTRIBUTE, {
					to: replayUsers[t],
					items: [bulkItem],
				});
				(op as any).txId = `tx_replay_multi_${t}`;
				return op;
			});

			// First pass — all 3 distribute normally
			for (const op of ops) await withTransaction((txn) => handleBulkDistribute(op, txn));

			// Replay all 3 — nothing should change
			for (const op of ops) await withTransaction((txn) => handleBulkDistribute(op, txn));

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = ${replayMultiId}`;
			expect(seed!.distributed).toBe(6);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = ${replayMultiId}`;
			expect(instances.length).toBe(6);
		});

	});

	// ─── transfer ───────────────────────────────────

	describe("transfer", () => {
		test("transfers NFT to new owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "bob" });
			await withTransaction((txn) => handleTransfer(op, txn));

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = ${SEED_TEST1}`;
			expect(nft!.owner).toBe("bob");
		});

		test("rejects transfer by non-owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "bob" }, "eve");
			await expect(withTransaction((txn) => handleTransfer(op, txn))).rejects.toThrow("not owner");
		});

		test("rejects transfer of burned (deleted) NFT", async () => {
			await seedCollection();
			await seedMint();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "null" }), txn));

			const op = makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "bob" });
			await expect(withTransaction((txn) => handleTransfer(op, txn))).rejects.toThrow("not found");
		});

		test("rejects transfer of listed NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const op = makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" });
			await expect(withTransaction((txn) => handleTransfer(op, txn))).rejects.toThrow("listed for sale");
		});

		test("allows transfer of NFT with expired listing", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));
			await sql`
				UPDATE nfts
				SET listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${instId}
			`;

			const op = makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" });
			await withTransaction((txn) => handleTransfer(op, txn));

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = ${instId}`;
			expect(nft!.owner).toBe("bob");
		});

		test("rejects transfer from non-transferable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "Locked Collection", "LOCK",
				{ rules: { transferable: false, burnable: true, royaltyPct: 0 } },
			);
			await withTransaction((txn) => handleCreateCollection(makeCreateCollectionOp(colData, "alice"), txn));

			const { op: mintOp, id: lockedId } = await makeMintOp("locked1", {
				collectionId: colId,
				metadata: { name: "Locked Seed" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			const op = makeOp(ACTION_TRANSFER, { nftId: lockedId, to: "bob" });
			await expect(withTransaction((txn) => handleTransfer(op, txn))).rejects.toThrow("not transferable");
		});

		test("rejects transfer of non-existent NFT", async () => {
			const op = makeOp(ACTION_TRANSFER, { nftId: "nft_ghost", to: "bob" });
			await expect(withTransaction((txn) => handleTransfer(op, txn))).rejects.toThrow("not found");
		});

		test("rejects transfer of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), txn));

			const op = makeOp(ACTION_TRANSFER, { nftId: instId, to: "charlie" });
			await expect(withTransaction((txn) => handleTransfer(op, txn))).rejects.toThrow("lent");
		});
	});

	// ─── burn ───────────────────────────────────────

	describe("burn", () => {
		test("burns NFT (hard delete)", async () => {
			await seedCollection();
			await seedMint();

			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "null" }), txn));

			const [nft] = await sql`SELECT 1 FROM nfts WHERE id = ${SEED_TEST1}`;
			expect(nft).toBeUndefined();

			const [burned] = await sql`SELECT * FROM burned_nfts WHERE id = ${SEED_TEST1}`;
			expect(burned).toBeDefined();
			expect(burned!.burned_by).toBe("alice");
			expect(burned!.created_at).toBeInstanceOf(Date);
		});

		test("rejects double burn", async () => {
			await seedCollection();
			await seedMint();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "null" }), txn));
			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "null" }), txn)),
			).rejects.toThrow("not found");
		});

		test("rejects burn of non-existent NFT", async () => {
			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "nft_ghost", to: "null" }), txn)),
			).rejects.toThrow("not found");
		});

		test("rejects burn from non-burnable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Burn", "NOBRN",
				{ rules: { transferable: true, burnable: false, royaltyPct: 0 } },
			);
			await withTransaction((txn) => handleCreateCollection(makeCreateCollectionOp(colData, "alice"), txn));
			const { op: noBurnOp, id: noBurnId } = await makeMintOp("noburn1", {
				collectionId: colId, metadata: { name: "No Burn Seed" },
			});
			await withTransaction((txn) => handleMint(noBurnOp, txn));

			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: noBurnId, to: "null" }), txn)),
			).rejects.toThrow("does not allow burning");
		});

		test("rejects burn of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), txn));

			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn)),
			).rejects.toThrow("lent");
		});

		test("rejects burn of listed NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn)),
			).rejects.toThrow("listed");
		});
	});

	// ─── list / unlist / buy ────────────────────────

	describe("marketplace", () => {
		test("list → unlist cycle", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const [listed] = await sql`SELECT status, listing_price, listing_currency FROM nfts WHERE id = ${instId}`;
			expect(listed!.status).toBe("listed");
			expect(Number(listed!.listing_price)).toBe(10);
			expect(listed!.listing_currency).toBe("HIVE");

			const unlistOp = makeOp(ACTION_UNLIST, { nftId: instId });
			await withTransaction((txn) => handleUnlist(unlistOp, txn));

			// Unlist is now two-phase: handler sets pending_unlist_block,
			// materialization flips status='active' after UNLIST_DELAY_BLOCKS.
			const [pending] = await sql`SELECT status, pending_unlist_block FROM nfts WHERE id = ${instId}`;
			expect(pending!.status).toBe("listed");
			expect(Number(pending!.pending_unlist_block)).toBe(unlistOp.blockNum);

			await withTransaction((txn) => materializePendingUnlists(
				unlistOp.blockNum + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn,
			));

			const [unlisted] = await sql`SELECT status, listing_price, pending_unlist_block FROM nfts WHERE id = ${instId}`;
			expect(unlisted!.status).toBe("active");
			expect(unlisted!.listing_price).toBeNull();
			expect(unlisted!.pending_unlist_block).toBeNull();
		});

		test("rejects list of seed NFTs", async () => {
			await seedCollection();
			await seedMint();
			const seedListData = await makeListData({ nftId: SEED_TEST1 });
			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, seedListData), txn)),
			).rejects.toThrow("Only instances");
		});

		test("rejects list when expiresAt equals block timestamp", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const expiresAt = new Date("2024-01-01T00:00:00").getTime();
			const listData = await makeListData({ nftId: instId, expiresAt });

			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn)),
			).rejects.toThrow("must be in the future");
		});

		test("queries, stats, cleanup, and payment-info only expose active instance listings", async () => {
			await seedCollection();
			await seedMint();
			const activeInstId = await seedInstance();
			const seedTxId = await getSeedTxId(SEED_TEST1);
			await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [{ seedId: SEED_TEST1, quantity: 1, seedTxId }],
			}), txn));
			const [expiredInst] = await sql`
				SELECT id FROM nfts
				WHERE seed_id = ${SEED_TEST1} AND id <> ${activeInstId}
				ORDER BY instance_number DESC
				LIMIT 1
			`;
			const expiredInstId = expiredInst!.id as string;
			await withTransaction(async (txn) => handleList(makeOp(ACTION_LIST, await makeListData({ nftId: activeInstId, priceAmount: "10.000" })), txn));
			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = 'legacy_seed_listing',
					listing_tx_id = 'tx_legacy_seed_listing',
					listing_price = 5,
					listing_currency = 'HIVE'
				WHERE id = ${SEED_TEST1}
			`;
			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = 'expired_instance_listing',
					listing_tx_id = 'tx_expired_instance_listing',
					listing_price = 1,
					listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${expiredInstId}
			`;
			await sql`UPDATE collection_stats SET listed = 99 WHERE collection_id = ${COL_ID}`;

			const listed = await queryNfts({ by: "listed" }, { limit: 20, offset: 0 });
			expect(listed.map((nft) => nft.id)).toEqual([activeInstId]);

			const ownerListed = await queryNfts(
				{ by: "owner", owner: "alice", status: "listed" },
				{ limit: 20, offset: 0 },
			);
			expect(ownerListed.map((nft) => nft.id)).toEqual([activeInstId]);

			const protocolStats = await getProtocolStats() as unknown as { readonly total_listed: number | string };
			expect(Number(protocolStats.total_listed)).toBe(1);
			const collectionStats = await getCollectionStats(COL_ID);
			expect(Number(collectionStats.total_listed)).toBe(1);
			expect(Number(collectionStats.floor_price)).toBe(10);

			const paymentResponse = await multisigRoutes.handle(
				new Request(`http://localhost/api/payment-info/${SEED_TEST1}`),
			);
			expect(paymentResponse.status).toBe(400);
			expect(await paymentResponse.json()).toEqual({ error: "Only instances can be bought" });

			const cleanup = await cleanupInvalidMarketplaceListings(sql);
			expect(cleanup.clearedListings).toBe(2);

			const [legacyState] = await sql`
				SELECT COUNT(*)::int AS count FROM nfts
				WHERE id IN (${SEED_TEST1}, ${expiredInstId})
					AND status = 'listed'
			`;
			expect(legacyState!.count).toBe(0);
			expect(await getCollectionStats(COL_ID)).toMatchObject({ total_listed: 1 });
		});

		test("rejects list for non-transferable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Transfer Collection", "NOTX",
				{ rules: { transferable: false, burnable: true, royaltyPct: 0 } },
			);
			await withTransaction((txn) => handleCreateCollection(makeCreateCollectionOp(colData, "alice"), txn));

			const { op: mintOp, id: noTransferId } = await makeMintOp("notransfer1", {
				collectionId: colId,
				metadata: { name: "Locked Seed" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			const instId = await seedInstanceFrom(noTransferId);
			const listData = await makeListData({ nftId: instId });
			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn)),
			).rejects.toThrow("not transferable");
		});

		test("buy rejects non-transferable collection", async () => {
			// Create non-transferable collection and mint a seed
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Buy Collection", "NOBUY",
				{ rules: { transferable: false, burnable: true, royaltyPct: 0 } },
			);
			await withTransaction((txn) => handleCreateCollection(makeCreateCollectionOp(colData, "alice"), txn));

			const { op: noBuyMintOp, id: noBuyId } = await makeMintOp("nobuy1", {
				collectionId: colId,
				metadata: { name: "No Buy Seed" },
			});
			await withTransaction((txn) => handleMint(noBuyMintOp, txn));
			const instId = await seedInstanceFrom(noBuyId);

			// Force-list via SQL (bypassing the list handler's transferable check)
			// to test the buy handler's own guard
			const listData = await makeListData({ nftId: instId });
			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = ${listData.listingId as string},
					listing_tx_id = 'tx_fake_list',
					listing_price = 10,
					listing_currency = 'HIVE'
				WHERE id = ${instId}
			`;

			const nodeAccount = config.hiveAccount;
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: "bob", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` },
			];
			const [nftTx] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${instId}`;

			const buyOp = makeOp(ACTION_BUY, {
				nftId: instId,
				listingId: listData.listingId,
				listTxId: "tx_fake_list",
				txId: nftTx!.tx_id,
			}, nodeAccount, transfers);

			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("not transferable");
		});

		test("rejects list of burned (deleted) NFT", async () => {
			await seedCollection();
			await seedMint();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "null" }), txn));

			const listData = await makeListData({ nftId: SEED_TEST1 });
			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn)),
			).rejects.toThrow("not found");
		});

		test("rejects list of non-existent NFT", async () => {
			const listData = await makeListData({ nftId: "nft_ghost" });
			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn)),
			).rejects.toThrow("not found");
		});

		test("rejects double list with active listing", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			const listData1 = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData1), txn));

			const listData2 = await makeListData({ nftId: instId, priceAmount: "20.000" });
			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData2), txn)),
			).rejects.toThrow("already listed");
		});

		test("rejects unlist of unlisted NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await expect(
				withTransaction((txn) => handleUnlist(makeOp(ACTION_UNLIST, { nftId: instId }), txn)),
			).rejects.toThrow("not listed");
		});

		test("rejects unlist by non-owner", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			await expect(
				withTransaction((txn) => handleUnlist(makeOp(ACTION_UNLIST, { nftId: instId }, "eve"), txn)),
			).rejects.toThrow("not owner");
		});

	});

	// ─── lending ────────────────────────────────────

	describe("nft_lend / nft_return", () => {
		test("lend sets status to lent", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			const [nft] = await sql`SELECT status, owner FROM nfts WHERE id = ${instId}`;
			expect(nft!.status).toBe("lent");
			expect(nft!.owner).toBe("alice"); // owner unchanged
		});

		test("lend creates loan record", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const lendOp = makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			});

			await withTransaction((txn) => handleNftLend(lendOp, txn));

			const [loan] = await sql`SELECT * FROM nft_loans WHERE nft_id = ${instId}`;
			expect(loan).toBeDefined();
			expect(loan!.lender).toBe("alice");
			expect(loan!.borrower).toBe("bob");
			expect(loan!.operation_id).toBe(lendOp.operationId);
		});

		test("return restores active status", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			await withTransaction((txn) => handleNftReturn(makeOp(ACTION_NFT_RETURN, {
				instanceId: instId,
			}), txn)); // alice (lender) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = ${instId}`;
			expect(nft!.status).toBe("active");

			const [loan] = await sql`SELECT * FROM nft_loans WHERE nft_id = ${instId}`;
			expect(loan).toBeUndefined();
		});

		test("borrower can return", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			await withTransaction((txn) => handleNftReturn(makeOp(ACTION_NFT_RETURN, {
				instanceId: instId,
			}, "bob"), txn)); // bob (borrower) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = ${instId}`;
			expect(nft!.status).toBe("active");
		});

		test("rejects lend to yourself", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: SEED_TEST1,
					borrower: "alice",
				}), txn)),
			).rejects.toThrow("Cannot lend to yourself");
		});

		test("rejects lend by non-owner", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await expect(
				withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: instId,
					borrower: "charlie",
				}, "eve"), txn)),
			).rejects.toThrow("not owner");
		});

		test("rejects double lend", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			await expect(
				withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: instId,
					borrower: "charlie",
				}), txn)),
			).rejects.toThrow("must be active");
		});

		test("rejects return by stranger", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			await expect(
				withTransaction((txn) => handleNftReturn(makeOp(ACTION_NFT_RETURN, {
					instanceId: instId,
				}, "eve"), txn)),
			).rejects.toThrow("neither lender nor borrower");
		});

		// ─── lent guards ────────────────────────────

		test("rejects transfer of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, {
					nftId: instId,
					to: "charlie",
				}), txn)),
			).rejects.toThrow("lent");
		});

		test("rejects burn of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn)),
			).rejects.toThrow("lent");
		});

		test("rejects list of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), txn));

			const listData = await makeListData({ nftId: instId });
			await expect(
				withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn)),
			).rejects.toThrow("lent");
		});

		test("rejects lend of burned (deleted) NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn));

			await expect(
				withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), txn)),
			).rejects.toThrow("not found");
		});

		test("rejects lend of non-existent NFT", async () => {
			await expect(
				withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: "nft_ghost", borrower: "bob" }), txn)),
			).rejects.toThrow("not found");
		});

		test("rejects lend from non-transferable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Lend", "NOLND",
				{ rules: { transferable: false, burnable: true, royaltyPct: 0 } },
			);
			await withTransaction((txn) => handleCreateCollection(makeCreateCollectionOp(colData, "alice"), txn));
			const { op: mintOp, id: noLendId } = await makeMintOp("nolend1", {
				collectionId: colId, maxSupply: 10,
				metadata: { name: "No Lend Seed" },
			});
			await withTransaction((txn) => handleMint(mintOp, txn));

			// Distribute an instance from the seed to test lend on an instance
			const nolendTxId = await getSeedTxId(noLendId);
			const distOp = makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [{ seedId: noLendId, quantity: 1, seedTxId: nolendTxId }],
			});
			await withTransaction((txn) => handleBulkDistribute(distOp, txn));
			const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = ${noLendId} LIMIT 1`;

			await expect(
				withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: inst!.id, borrower: "bob" }), txn)),
			).rejects.toThrow("not transferable");
		});

		test("rejects return of non-lent (active) NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await expect(
				withTransaction((txn) => handleNftReturn(makeOp(ACTION_NFT_RETURN, { instanceId: instId }), txn)),
			).rejects.toThrow("not lent");
		});
	});

	// ─── marketplace + allowances interaction ──────

	describe("marketplace & third-party coexistence", () => {

		// Escenario A: Juego aprobado no puede mover NFT listado
		test("transferFrom blocked while NFT is listed", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Alice aprueba a "gameshop" como spender
			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop",
				instanceId: instId,
				approved: true,
			}), txn));

			// Alice lista el NFT en el marketplace built-in
			const listData = await makeListData({ nftId: instId, priceAmount: "50.000" });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			// gameshop intenta mover el NFT → bloqueado
			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice",
					to: "buyer1",
					instanceId: instId,
				}, "gameshop"), txn)),
			).rejects.toThrow("listed for sale");
		});

		// After unlist, approved spender can transfer
		test("transferFrom succeeds after unlist", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop",
				instanceId: instId,
				approved: true,
			}), txn));

			const listData2 = await makeListData({ nftId: instId, priceAmount: "50.000" });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData2), txn));

			// Alice quita el listado (two-phase: handler + materialize after delay)
			const unlistOp = makeOp(ACTION_UNLIST, { nftId: instId });
			await withTransaction((txn) => handleUnlist(unlistOp, txn));
			await withTransaction((txn) => materializePendingUnlists(
				unlistOp.blockNum + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn,
			));

			// Ahora gameshop puede mover el NFT
			await withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice",
				to: "buyer1",
				instanceId: instId,
			}, "gameshop"), txn));

			const [nft] = await sql`SELECT owner, status FROM nfts WHERE id = ${instId}`;
			expect(nft!.owner).toBe("buyer1");
			expect(nft!.status).toBe("active");
		});

		// Escenario A con approve_all: mismo guard aplica
		test("transferFrom via approve_all blocked while listed", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Approve "marketbot" for the entire collection
			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "marketbot",
				collectionId: COL_ID,
				approved: true,
			}), txn));

			const listData3 = await makeListData({ nftId: instId, priceAmount: "100.000" });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData3), txn));

			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice",
					to: "buyer2",
					instanceId: instId,
				}, "marketbot"), txn)),
			).rejects.toThrow("listed for sale");
		});

		// Escenario C: tercero puro (sin marketplace built-in)
		test("approve → transferFrom works on active NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Alice aprueba a marketbot
			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "marketbot",
				instanceId: instId,
				approved: true,
			}), txn));

			// marketbot transfiere a buyer (pago HIVE fuera del indexador)
			await withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice",
				to: "buyer3",
				instanceId: instId,
			}, "marketbot"), txn));

			const [nft] = await sql`SELECT owner, status FROM nfts WHERE id = ${instId}`;
			expect(nft!.owner).toBe("buyer3");
			expect(nft!.status).toBe("active");

			// Allowance cleared after transferFrom
			const [allowance] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(allowance).toBeUndefined();
		});

		test("transferFrom rejected without approval", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "buyer1", instanceId: instId,
				}, "stranger"), txn)),
			).rejects.toThrow();
		});

		test("transferFrom rejected with wrong from", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "eve", to: "buyer1", instanceId: instId,
				}, "gameshop"), txn)),
			).rejects.toThrow("not owner");
		});

		test("transferFrom rejected for self-transfer (from === to)", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "alice", instanceId: instId,
				}, "gameshop"), txn)),
			).rejects.toThrow();
		});

		test("transferFrom rejected for burned (deleted) NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn));

			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "buyer1", instanceId: instId,
				}, "gameshop"), txn)),
			).rejects.toThrow("not found");
		});

		test("transferFrom rejected for lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));
			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), txn));

			await expect(
				withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "buyer1", instanceId: instId,
				}, "gameshop"), txn)),
			).rejects.toThrow("lent");
		});

	});

	// ─── marketplace fees & royalties ──────────────────────────

	describe("marketplace fees & royalties", () => {
		test("list with marketplace stores it in DB", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			const listData = await makeListData({ nftId: instId, marketplace: "norse" });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const [nft] = await sql`SELECT listing_marketplace, listing_price, status FROM nfts WHERE id = ${instId}`;
			expect(nft!.listing_marketplace).toBe("norse");
			expect(nft!.status).toBe("listed");
		});

		test("list without marketplace stores null", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const [nft] = await sql`SELECT listing_marketplace FROM nfts WHERE id = ${instId}`;
			expect(nft!.listing_marketplace).toBeNull();
		});
	});

	// ─── signer validation (congruence fixes) ──────────────────

	describe("signer validation", () => {
		test("create_collection derives creator from fee payer (canonical source)", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "FromFeePayer", "FFP",
			);
			// Payload no longer carries `creator` — indexer resolves it purely from
			// `transfer.from`. Any stray `creator` key on `data` must be ignored (not
			// validated) because the field has been removed from the protocol type.
			const op = makeCreateCollectionOp(colData, "alice");
			await withTransaction((txn) => handleCreateCollection(op, txn));

			const [row] = await sql`SELECT creator FROM collections WHERE id = ${colId}`;
			expect(row).toBeDefined();
			expect(row!.creator).toBe("alice");
		});

		test("mint rejects non-creator signer", async () => {
			await seedCollection();
			const { op } = await makeMintOp("evil", {
				metadata: { name: "Evil" },
			}, "eve");
			await expect(withTransaction((txn) => handleMint(op, txn))).rejects.toThrow("Only the collection creator can mint");
		});

		test("self-transfer rejected", async () => {
			await seedCollection();
			await seedMint();
			await expect(
				withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "alice" }), txn)),
			).rejects.toThrow();
		});

		test("self-approval rejected (nft_approve)", async () => {
			await seedCollection();
			await seedMint();
			await expect(
				withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
					spender: "alice",
					instanceId: SEED_TEST1,
					approved: true,
				}), txn)),
			).rejects.toThrow();
		});

		test("self-approval rejected (nft_approve_all)", async () => {
			await seedCollection();
			await expect(
				withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
					spender: "alice",
					collectionId: COL_ID,
					approved: true,
				}), txn)),
			).rejects.toThrow();
		});

	});

	// ─── buy handler guards ───────────────────────────

	describe("buy guards", () => {
		const nodeAccount = config.hiveAccount;

		async function listNft(nftId: string, priceAmount = "10.000") {
			const listData = await makeListData({ nftId, priceAmount });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));
			const [nft] = await sql`SELECT listing_id, listing_tx_id, created_tx_id AS tx_id FROM nfts WHERE id = ${nftId}`;
			return { listingId: nft!.listing_id as string, listTxId: nft!.listing_tx_id as string, txId: nft!.tx_id as string };
		}

		function makeBuyOp(nftId: string, listingId: string, listTxId: string, buyer: string, seller: string, price = 10, txId = "a".repeat(40)) {
			const split = calculatePaymentSplit(price, "HIVE", 0, null, seller, nodeAccount);
			const transfers = [
				{ from: buyer, to: seller, amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${nftId}` },
				...(split.feeAmount > 0 ? [{ from: buyer, to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${nftId}` }] : []),
			];
			return makeOp(ACTION_BUY, { nftId, listingId, listTxId, txId }, nodeAccount, transfers);
		}

		test("rejects buy own NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, listTxId, txId } = await listNft(instId);

			// alice owns the NFT, alice tries to buy — paired transfer from alice
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "alice", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: "alice", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` },
			];
			const buyOp = makeOp(ACTION_BUY, {
				nftId: instId, listingId, listTxId, txId,
			}, nodeAccount, transfers);

			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("Cannot buy own");
		});

		test("rejects buy unlisted NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			const buyOp = makeBuyOp(instId, "list_fake", "tx_fake", "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("not listed");
		});

		test("rejects buy non-existent NFT", async () => {
			const buyOp = makeBuyOp("nft_ghost", "list_fake", "tx_fake", "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("not found");
		});

		test("rejects buy burned (deleted) NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn));

			const buyOp = makeBuyOp(instId, "list_fake", "tx_fake", "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("not found");
		});

		test("rejects buy lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), txn));

			const buyOp = makeBuyOp(instId, "list_fake", "tx_fake", "charlie", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("lent");
		});

		test("rejects buy with expired listing", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Force-list with past expiry via SQL
			await sql`
				UPDATE nfts
				SET status = 'listed', listing_id = 'list_expired', listing_tx_id = 'tx_exp',
					listing_price = 10, listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${instId}
			`;

			const buyOp = makeBuyOp(instId, "list_expired", "tx_exp", "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("expired");
		});

		test("rejects buy of listed seed NFTs", async () => {
			await seedCollection();
			await seedMint();

			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = 'legacy_seed_buy',
					listing_tx_id = 'tx_legacy_seed_buy',
					listing_price = 10,
					listing_currency = 'HIVE'
				WHERE id = ${SEED_TEST1}
			`;
			const [seed] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${SEED_TEST1}`;

			await expect(
				withTransaction((txn) => handleBuy(makeBuyOp(SEED_TEST1, "legacy_seed_buy", "tx_legacy_seed_buy", "bob", "alice", 10, seed!.tx_id as string), txn)),
			).rejects.toThrow("Only instances");
		});

		test("rejects buy with listingId mismatch", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listTxId } = await listNft(instId);

			const buyOp = makeBuyOp(instId, "list_wrong_id", listTxId, "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("listingId mismatch");
		});

		test("rejects buy with listTxId mismatch", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId } = await listNft(instId);

			const buyOp = makeBuyOp(instId, listingId, "tx_wrong", "bob", "alice");
			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("listTxId mismatch");
		});

		test("rejects buy with wrong payment amount", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const { listingId, listTxId, txId } = await listNft(instId);

			// Send wrong amount (50 instead of 9.9 to seller)
			const transfers = [
				{ from: "bob", to: "alice", amount: 50, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: "bob", to: nodeAccount, amount: 0.1, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` },
			];
			const buyOp = makeOp(ACTION_BUY, {
				nftId: instId, listingId, listTxId, txId,
			}, nodeAccount, transfers);

			await expect(withTransaction((txn) => handleBuy(buyOp, txn))).rejects.toThrow("Missing");
		});
	});

	// ─── approval lifecycle ───────────────────────────

	describe("approval lifecycle", () => {
		test("transfer clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			const [before] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(before).toBeDefined();

			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" }), txn));

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("burn clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), txn));

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("buy clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			// List and buy
			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const [nft] = await sql`SELECT listing_id, listing_tx_id, created_tx_id AS tx_id FROM nfts WHERE id = ${instId}`;
			const nodeAccount = config.hiveAccount;
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: "bob", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` },
			];
			const buyOp = makeOp(ACTION_BUY, {
				nftId: instId,
				listingId: nft!.listing_id,
				listTxId: nft!.listing_tx_id,
				txId: nft!.tx_id,
			}, nodeAccount, transfers);
			await withTransaction((txn) => handleBuy(buyOp, txn));

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("lend clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await withTransaction((txn) => handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), txn));

			await withTransaction((txn) => handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId, borrower: "bob",
			}), txn));

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		// Universal invariant A4': collection_allowances(owner=X, collection=Y) MUST
		// be deleted whenever owner_count(X, Y) transitions to 0 — regardless of
		// which action caused the transition (transfer, buy, burn, transfer_from).
		// Rationale: keeps a zombie approval from re-activating against NFTs the
		// owner later re-acquires in the same collection.
		test("collection_allowances persist after nft_transfer_from when owner has remaining NFTs", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// alice still owns the seed after this transfer_from → allowance stays
			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "gameshop", collectionId: COL_ID, approved: true,
			}), txn));

			await withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice", to: "bob", instanceId: instId,
			}, "gameshop"), txn));

			const [allowance] = await sql`
				SELECT * FROM collection_allowances
				WHERE collection_id = ${COL_ID} AND owner = 'alice' AND spender = 'gameshop'
			`;
			expect(allowance).toBeDefined();
		});

		test("collection_allowances cleaned after nft_transfer_from empties owner", async () => {
			await seedCollection();
			// Bob owns the seed; alice owns only the distributed instance. This
			// setup isolates the transfer_from path: there is no seed lingering
			// under alice's ownership to mask the count→0 transition.
			const { op: mintOp, id: bobSeedId } = await makeMintOp("bob_seed", { owner: "bob" });
			await withTransaction((txn) => handleMint(mintOp, txn));
			const bobSeedTxId = await getSeedTxId(bobSeedId);
			await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "alice",
				items: [{ seedId: bobSeedId, quantity: 1, seedTxId: bobSeedTxId }],
			}, "bob"), txn));
			const [instRow] = await sql`SELECT id FROM nfts WHERE seed_id = ${bobSeedId} AND owner = 'alice' LIMIT 1`;
			const instId = instRow!.id as string;

			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "gameshop", collectionId: COL_ID, approved: true,
			}), txn));

			await withTransaction((txn) => handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice", to: "charlie", instanceId: instId,
			}, "gameshop"), txn));

			const [after] = await sql`
				SELECT * FROM collection_allowances
				WHERE collection_id = ${COL_ID} AND owner = 'alice' AND spender = 'gameshop'
			`;
			expect(after).toBeUndefined();
		});

		test("collection_allowances cleaned after burn empties owner", async () => {
			await seedCollection();
			await seedMint();

			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "gameshop", collectionId: COL_ID, approved: true,
			}), txn));

			// Burn the seed (alice's only NFT in the collection) → 0 remaining
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, {
				nftId: SEED_TEST1, to: "null",
			}), txn));

			const [after] = await sql`
				SELECT * FROM collection_allowances
				WHERE collection_id = ${COL_ID} AND owner = 'alice' AND spender = 'gameshop'
			`;
			expect(after).toBeUndefined();
		});

		test("collection_allowances cleaned after buy empties seller", async () => {
			await seedCollection();
			// Bob owns the seed, alice owns only a distributed instance — so the
			// buy fully empties alice's holdings in COL_ID.
			const { op: mintOp, id: bobSeedId } = await makeMintOp("bob_seed_buy", { owner: "bob" });
			await withTransaction((txn) => handleMint(mintOp, txn));
			const bobSeedTxId = await getSeedTxId(bobSeedId);
			await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "alice",
				items: [{ seedId: bobSeedId, quantity: 1, seedTxId: bobSeedTxId }],
			}, "bob"), txn));
			const [instRow] = await sql`SELECT id FROM nfts WHERE seed_id = ${bobSeedId} AND owner = 'alice' LIMIT 1`;
			const instId = instRow!.id as string;

			await withTransaction((txn) => handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "gameshop", collectionId: COL_ID, approved: true,
			}), txn));

			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const [nft] = await sql`SELECT listing_id, listing_tx_id, created_tx_id AS tx_id FROM nfts WHERE id = ${instId}`;
			const nodeAccount = config.hiveAccount;
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "charlie", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				{ from: "charlie", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` },
			];
			const buyOp = makeOp(ACTION_BUY, {
				nftId: instId,
				listingId: nft!.listing_id,
				listTxId: nft!.listing_tx_id,
				txId: nft!.tx_id,
			}, nodeAccount, transfers);
			await withTransaction((txn) => handleBuy(buyOp, txn));

			const [after] = await sql`
				SELECT * FROM collection_allowances
				WHERE collection_id = ${COL_ID} AND owner = 'alice' AND spender = 'gameshop'
			`;
			expect(after).toBeUndefined();
		});
	});

	describe("data operator boundary enforcement", () => {
		test("non-operator cannot write mutable_data via set_data_from", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			const [nft] = await sql`SELECT instance_dna FROM nfts WHERE id = ${instId}`;

			// bob (not an operator) tries set_data_from — must fail
			const op = makeOp(ACTION_SET_DATA_FROM, {
				nftId: instId,
				instanceDna: nft!.instance_dna,
				mutableData: { level: 99 },
			}, "bob");

			await expect(withTransaction((txn) => handleSetDataFrom(op, txn))).rejects.toThrow("not an approved data operator");
		});
	});

	// ─── atomic supply & approve guards (DB integration) ─────

	describe("atomic supply and approve guards", () => {
		beforeEach(cleanDb);

		test("updateLastBlock never regresses cursor", async () => {
			const { updateLastBlock, getLastBlock } = await import("@/db/queries/sync.ts");

			await updateLastBlock(5000);
			expect(await getLastBlock()).toBe(5000);

			// Try to set it backwards — should be ignored
			await updateLastBlock(3000);
			expect(await getLastBlock()).toBe(5000);

			// Advance forward — should work
			await updateLastBlock(6000);
			expect(await getLastBlock()).toBe(6000);
		});
	});

	// ─── Counter management ─────────────────────────────────────────────────────
	// Verifies that owner_nft_counts and collection_stats are maintained correctly
	// by the application layer (no DB triggers). Each test exercises a distinct
	// state transition and asserts exact counter values.

	describe("Counter management", () => {
		async function ownerCounts(owner: string) {
			const [r] = await sql`
				SELECT total, seeds, instances
				FROM owner_nft_counts WHERE owner = ${owner}
			`;
			return {
				total:     Number(r?.total ?? 0),
				seeds:     Number(r?.seeds ?? 0),
				instances: Number(r?.instances ?? 0),
			};
		}

		async function collStats(collectionId: string) {
			const [r] = await sql`
				SELECT total, seeds, instances, listed, burned
				FROM collection_stats WHERE collection_id = ${collectionId}
			`;
			return {
				total:     Number(r?.total ?? 0),
				seeds:     Number(r?.seeds ?? 0),
				instances: Number(r?.instances ?? 0),
				listed:    Number(r?.listed ?? 0),
				burned:    Number(r?.burned ?? 0),
			};
		}

		test("mint increments owner and collection counters", async () => {
			await seedCollection();
			await seedMint();

			expect(await ownerCounts("alice")).toMatchObject({ total: 1, seeds: 1, instances: 0 });
			expect(await collStats(COL_ID)).toMatchObject({ total: 1, seeds: 1, instances: 0, listed: 0, burned: 0 });
		});

		test("duplicate mint (idempotent) does not double-increment counters", async () => {
			await seedCollection();
			await seedMint();
			await seedMint(); // ON CONFLICT DO NOTHING — counters must not increment twice

			expect(await ownerCounts("alice")).toMatchObject({ total: 1, seeds: 1 });
			expect(await collStats(COL_ID)).toMatchObject({ total: 1, seeds: 1 });
		});

		test("bulk_distribute increments instance counters for recipient", async () => {
			await seedCollection();
			await seedMint();
			const seedTxId = await getSeedTxId(SEED_TEST1);
			await withTransaction((txn) => handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: SEED_TEST1, quantity: 3, seedTxId }],
			}), txn));

			expect(await ownerCounts("bob")).toMatchObject({ total: 3, instances: 3, seeds: 0 });
			expect(await ownerCounts("alice")).toMatchObject({ total: 1, seeds: 1 }); // seed stays with alice
			expect(await collStats(COL_ID)).toMatchObject({ total: 4, seeds: 1, instances: 3 });
		});

		test("transfer shifts owner counters, collection total unchanged", async () => {
			await seedCollection();
			await seedMint();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "bob" }), txn));

			expect(await ownerCounts("alice")).toMatchObject({ total: 0, seeds: 0 });
			expect(await ownerCounts("bob")).toMatchObject({ total: 1, seeds: 1 });
			expect(await collStats(COL_ID)).toMatchObject({ total: 1, seeds: 1, listed: 0 });
		});

		test("transfer of expired-listed NFT decrements listed and shifts owner", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction(async (txn) => handleList(makeOp(ACTION_LIST, await makeListData({ nftId: instId })), txn));
			await sql`
				UPDATE nfts
				SET listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${instId}
			`;
			expect(await collStats(COL_ID)).toMatchObject({ listed: 1 });

			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" }), txn));

			expect(await collStats(COL_ID)).toMatchObject({ listed: 0 });
			expect(await ownerCounts("alice")).toMatchObject({ total: 1, seeds: 1, instances: 0 });
			expect(await ownerCounts("bob")).toMatchObject({ total: 1 });
		});

		test("burn decrements owner and collection counters, increments burned", async () => {
			await seedCollection();
			await seedMint();
			await withTransaction((txn) => handleTransfer(makeOp(ACTION_TRANSFER, { nftId: SEED_TEST1, to: "null" }), txn));

			expect(await ownerCounts("alice")).toMatchObject({ total: 0, seeds: 0 });
			expect(await collStats(COL_ID)).toMatchObject({ total: 0, seeds: 0, burned: 1 });
		});

		test("list increments listed counter without changing owner count", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction(async (txn) => handleList(makeOp(ACTION_LIST, await makeListData({ nftId: instId })), txn));

			expect(await collStats(COL_ID)).toMatchObject({ listed: 1 });
			expect(await ownerCounts("alice")).toMatchObject({ total: 2, seeds: 1, instances: 1 });
		});

		test("unlist decrements listed counter after materialization", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction(async (txn) => handleList(makeOp(ACTION_LIST, await makeListData({ nftId: instId })), txn));

			const unlistOp = makeOp(ACTION_UNLIST, { nftId: instId });
			await withTransaction((txn) => handleUnlist(unlistOp, txn));
			// listed counter only moves on materialization — during the delay the
			// NFT is still listed, so stats must not change yet.
			expect(await collStats(COL_ID)).toMatchObject({ listed: 1 });

			await withTransaction((txn) => materializePendingUnlists(
				unlistOp.blockNum + UNLIST_DELAY_BLOCKS, UNLIST_DELAY_BLOCKS, txn,
			));
			expect(await collStats(COL_ID)).toMatchObject({ listed: 0 });
		});

		test("re-listing an expired listing keeps listed counter at 1", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await withTransaction(async (txn) => handleList(makeOp(ACTION_LIST, await makeListData({ nftId: instId })), txn));
			await sql`
				UPDATE nfts
				SET listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = ${instId}
			`;
			expect(await collStats(COL_ID)).toMatchObject({ listed: 1 });

			// Re-list (overwriting expired) — must stay at 1, not go to 2
			await withTransaction(async (txn) => handleList(makeOp(ACTION_LIST, await makeListData({ nftId: instId })), txn));
			expect(await collStats(COL_ID)).toMatchObject({ listed: 1 });
		});

		test("buy shifts owner counters and decrements listed", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			const listData = await makeListData({ nftId: instId });
			await withTransaction((txn) => handleList(makeOp(ACTION_LIST, listData), txn));

			const [nftRow] = await sql`SELECT listing_id, listing_tx_id, created_tx_id AS tx_id FROM nfts WHERE id = ${instId}`;
			const nodeAccount = config.hiveAccount;
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}${instId}` },
				...(split.feeAmount > 0 ? [{ from: "bob", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}${instId}` }] : []),
			];
			await withTransaction((txn) => handleBuy(makeOp(ACTION_BUY, {
				nftId: instId,
				listingId: nftRow!.listing_id,
				listTxId: nftRow!.listing_tx_id,
				txId: nftRow!.tx_id,
			}, nodeAccount, transfers), txn));

			expect(await ownerCounts("alice")).toMatchObject({ total: 1, seeds: 1, instances: 0 });
			expect(await ownerCounts("bob")).toMatchObject({ total: 1, instances: 1 });
			expect(await collStats(COL_ID)).toMatchObject({ listed: 0 });
		});
	});

});

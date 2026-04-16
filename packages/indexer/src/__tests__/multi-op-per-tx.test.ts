/**
 * Multi-Operation per Transaction Tests
 *
 * Hive allows up to 5 custom_json operations per transaction, all sharing the
 * same tx_id but with distinct operation_ids (assigned by HafAH).
 * A single block can also contain multiple transactions from different signers.
 *
 * These tests verify that the indexer correctly handles:
 * 1. Multiple valid ops in the same tx (same tx_id, different operation_id)
 * 2. Mix of valid and invalid ops in the same tx
 * 3. Multiple independent transactions in the same block
 * 4. Idempotency of replay for multi-op transactions
 * 5. Audit trail distinguishes every op even within the same tx
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, type Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleUnlist } from "@/processor/handlers/marketplace/unlist.ts";
import { routeOperation } from "@/processor/action-router.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTIVE_AUTH_ACTIONS,
	generateListingNonce,
	generateListingId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
} from "@/protocol/index.ts";

/**
 * Resolves the canonical seedId for a given artId. Mirrors the indexer's
 * canonical enforcement so fixtures can reference seeds via short human-readable
 * artIds while the handler receives the authoritative hash.
 */
async function canonicalSeedId(artId: string, collectionId: string): Promise<string> {
	return generateDeterministicSeedId(collectionId, artId);
}

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);
const SHARED_BLOCK = 90000200;
const SHARED_TIMESTAMP = "2024-06-15T12:00:00";

let COL_ID: string;

// ─── Helpers ─────────────────────────────────────

let opCounter = 0;

/**
 * Creates a ParsedOperation with explicit control over txId and operationId.
 * This allows simulating multiple ops sharing the same tx_id (as Hive does).
 */
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
	const id = ++opCounter;
	const signer = overrides.signer ?? "alice";
	return {
		blockNum: overrides.blockNum ?? SHARED_BLOCK,
		timestamp: SHARED_TIMESTAMP,
		txId: overrides.txId ?? `tx_multi_${Date.now()}_${id}`,
		operationId: overrides.operationId ?? `op_multi_${id}`,
		signer,
		authLevel: ACTIVE_SET.has(action) ? "active" : "posting",
		action: action as ParsedOperation["action"],
		version: "0.2.1",
		data,
		pairedTransfers: overrides.pairedTransfers,
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
	await sql`DELETE FROM invalid_operations`;
	await sql`DELETE FROM orphaned_buys`;
}

async function seedCollection(txn: Queryable = sql) {
	await handleCreateCollection(makeOp(ACTION_CREATE_COLLECTION, {
		id: COL_ID,
		name: "Multi-Op Collection",
		symbol: "MULTI",
		totalPotential: 100,
		metadata: { description: "Multi-op test", image: "https://example.com/img.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 0 },
	}), txn);
}

async function makeListData(nftId: string, owner = "alice"): Promise<Record<string, unknown>> {
	const nonce = generateListingNonce();
	const listingId = await generateListingId({
		nftId,
		owner,
		marketplace: "",
		priceAmount: "10.000",
		priceCurrency: "HIVE",
		expiresAt: 0,
		nonce,
	});
	return { nftId, listingId, listingNonce: nonce, price: { amount: "10.000", currency: "HIVE" } };
}

// ─── Setup ───────────────────────────────────────

describe("Multi-operation per transaction", () => {
	beforeAll(async () => {
		COL_ID = await generateDeterministicCollectionId("alice", "Multi-Op Collection", "MULTI");
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

	// ─── Scenario 1: Multiple mints in the same tx ──────────

	describe("multiple mints sharing the same tx_id", () => {
		test("2 distinct seeds in the same tx succeed independently", async () => {
			await seedCollection();
			const sharedTxId = "tx_shared_mint_001";

			const seedA = await canonicalSeedId("multi_a", COL_ID);
			const seedB = await canonicalSeedId("multi_b", COL_ID);

			const mint1 = makeOp(ACTION_MINT, {
				id: seedA,
				artId: "multi_a",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 5,
				metadata: { name: "Seed A", imageUrl: "https://example.com/a.png", imageHash: "hash_a" },
			}, { txId: sharedTxId, operationId: "op_mint_a" });

			const mint2 = makeOp(ACTION_MINT, {
				id: seedB,
				artId: "multi_b",
				collectionId: COL_ID,
				edition: 2,
				owner: "alice",
				maxSupply: 5,
				metadata: { name: "Seed B", imageUrl: "https://example.com/b.png", imageHash: "hash_b" },
			}, { txId: sharedTxId, operationId: "op_mint_b" });

			// Process sequentially as the sync engine would
			await handleMint(mint1, sql);
			await handleMint(mint2, sql);

			// Both seeds should exist with the same tx_id
			const seeds = await sql`
				SELECT id, created_tx_id AS tx_id FROM nfts WHERE created_tx_id = ${sharedTxId} ORDER BY id
			`;
			expect(seeds.length).toBe(2);
			expect(seeds.map(s => s.id).sort()).toEqual([seedA, seedB].sort());
			expect(seeds[0]!.tx_id).toBe(sharedTxId);
			expect(seeds[1]!.tx_id).toBe(sharedTxId);
		});

		test("replay of multi-mint tx is fully idempotent", async () => {
			await seedCollection();
			const sharedTxId = "tx_replay_mint";
			const replayA = await canonicalSeedId("replay_a", COL_ID);
			const replayB = await canonicalSeedId("replay_b", COL_ID);

			const ops = [
				makeOp(ACTION_MINT, {
					id: replayA, artId: "replay_a", collectionId: COL_ID, edition: 1,
					owner: "alice", maxSupply: 3,
					metadata: { name: "Replay A", imageUrl: "https://example.com/a.png", imageHash: "h1" },
				}, { txId: sharedTxId, operationId: "op_r1" }),
				makeOp(ACTION_MINT, {
					id: replayB, artId: "replay_b", collectionId: COL_ID, edition: 2,
					owner: "alice", maxSupply: 3,
					metadata: { name: "Replay B", imageUrl: "https://example.com/b.png", imageHash: "h2" },
				}, { txId: sharedTxId, operationId: "op_r2" }),
			];

			// First pass
			for (const op of ops) await handleMint(op, sql);
			const countBefore = await sql`SELECT COUNT(*)::int AS n FROM nfts WHERE created_tx_id = ${sharedTxId}`;

			// Replay (same ops again)
			for (const op of ops) await handleMint(op, sql);
			const countAfter = await sql`SELECT COUNT(*)::int AS n FROM nfts WHERE created_tx_id = ${sharedTxId}`;

			expect(countBefore[0]!.n).toBe(2);
			expect(countAfter[0]!.n).toBe(2);
		});
	});

	// ─── Scenario 2: Mint + list in the same tx ─────────────

	describe("mint then list in the same tx", () => {
		test("mint and list with the same tx_id both succeed", async () => {
			await seedCollection();
			const sharedTxId = "tx_mint_and_list";
			const mintListId = await canonicalSeedId("mintlist", COL_ID);

			// Op 1: mint seed
			const mintOp = makeOp(ACTION_MINT, {
				id: mintListId,
				artId: "mintlist",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 5,
				metadata: { name: "MintList", imageUrl: "https://example.com/ml.png", imageHash: "ml_h" },
			}, { txId: sharedTxId, operationId: "op_ml_mint" });

			await handleMint(mintOp, sql);

			// Op 2: distribute an instance, then list the instance (different operation_id, same tx_id)
			await handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [{ seedId: mintListId, quantity: 1, seedTxId: sharedTxId }],
			}, { txId: sharedTxId, operationId: "op_ml_distribute" }), sql);
			const [instance] = await sql`SELECT id FROM nfts WHERE seed_id = ${mintListId} LIMIT 1`;
			const instanceId = instance!.id as string;
			const listData = await makeListData(instanceId);
			const listOp = makeOp(ACTION_LIST, listData, {
				txId: sharedTxId,
				operationId: "op_ml_list",
			});
			await handleList(listOp, sql);

			const [nft] = await sql`SELECT status, listing_price, created_tx_id AS tx_id, listing_tx_id FROM nfts WHERE id = ${instanceId}`;
			expect(nft!.status).toBe("listed");
			expect(Number(nft!.listing_price)).toBe(10);
			// tx_id is the CREATION tx
			expect(nft!.tx_id).toBe(sharedTxId);
			// listing_tx_id is the LISTING tx (same here)
			expect(nft!.listing_tx_id).toBe(sharedTxId);
		});
	});

	// ─── Scenario 3: Valid + invalid ops in the same tx ─────

	describe("mix of valid and invalid ops in the same tx", () => {
		test("valid op succeeds even when another op in the same tx fails", async () => {
			await seedCollection();
			const sharedTxId = "tx_mixed_validity";
			const validId = await canonicalSeedId("valid", COL_ID);
			const invalidId = await canonicalSeedId("invalid", "col_does_not_exist");

			// Op 1: valid mint
			const validMint = makeOp(ACTION_MINT, {
				id: validId,
				artId: "valid",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 5,
				metadata: { name: "Valid", imageUrl: "https://example.com/v.png", imageHash: "vh" },
			}, { txId: sharedTxId, operationId: "op_valid" });

			// Op 2: invalid mint (non-existent collection)
			const invalidMint = makeOp(ACTION_MINT, {
				id: invalidId,
				artId: "invalid",
				collectionId: "col_does_not_exist",
				edition: 1,
				owner: "alice",
				maxSupply: 5,
				metadata: { name: "Invalid", imageUrl: "https://example.com/i.png", imageHash: "ih" },
			}, { txId: sharedTxId, operationId: "op_invalid" });

			// Route both through action-router (infallible — records invalid ops)
			await routeOperation(validMint, sql);
			await routeOperation(invalidMint, sql);

			// Valid op should have created the NFT
			const [nft] = await sql`SELECT id FROM nfts WHERE id = ${validId}`;
			expect(nft).toBeDefined();

			// Invalid op should NOT have created anything
			const [ghost] = await sql`SELECT id FROM nfts WHERE id = ${invalidId}`;
			expect(ghost).toBeUndefined();

			// Invalid op should be recorded with its own operation_id
			const invalids = await sql`
				SELECT operation_id, action, reason FROM invalid_operations
				WHERE tx_id = ${sharedTxId}
			`;
			expect(invalids.length).toBe(1);
			expect(invalids[0]!.operation_id).toBe("op_invalid");
			expect(invalids[0]!.action).toBe(ACTION_MINT);
		});

		test("two invalid ops with the same action in the same tx are both recorded", async () => {
			const sharedTxId = "tx_double_invalid";
			const bad1 = await canonicalSeedId("bad_1", "col_fake_1");
			const bad2 = await canonicalSeedId("bad_2", "col_fake_2");

			// Two invalid mints (same action, same tx, different operation_id)
			const invalid1 = makeOp(ACTION_MINT, {
				id: bad1,
				artId: "bad_1",
				collectionId: "col_fake_1",
				edition: 1,
				owner: "alice",
				maxSupply: 1,
				metadata: { name: "Bad1", imageUrl: "https://example.com/b1.png", imageHash: "b1" },
			}, { txId: sharedTxId, operationId: "op_bad_1" });

			const invalid2 = makeOp(ACTION_MINT, {
				id: bad2,
				artId: "bad_2",
				collectionId: "col_fake_2",
				edition: 1,
				owner: "alice",
				maxSupply: 1,
				metadata: { name: "Bad2", imageUrl: "https://example.com/b2.png", imageHash: "b2" },
			}, { txId: sharedTxId, operationId: "op_bad_2" });

			await routeOperation(invalid1, sql);
			await routeOperation(invalid2, sql);

			// Both must be recorded — old index (tx_id, action) would have lost one
			const invalids = await sql`
				SELECT operation_id FROM invalid_operations
				WHERE tx_id = ${sharedTxId}
				ORDER BY operation_id
			`;
			expect(invalids.length).toBe(2);
			expect(invalids[0]!.operation_id).toBe("op_bad_1");
			expect(invalids[1]!.operation_id).toBe("op_bad_2");
		});
	});

	// ─── Scenario 3b: 5 ops max (Hive limit) ────────────────

	describe("5 ops in one tx (Hive max)", () => {
		test("4 valid + 1 invalid — all tracked independently", async () => {
			await seedCollection();
			const sharedTxId = "tx_5ops_max";

			const validSeeds = ["a", "b", "c", "d"];
			const validIds = await Promise.all(
				validSeeds.map(l => canonicalSeedId(`5op_${l}`, COL_ID)),
			);
			const invalidSeedId = await canonicalSeedId("5op_bad", "col_nonexistent");
			const validOps = validSeeds.map((letter, i) =>
				makeOp(ACTION_MINT, {
					id: validIds[i]!, artId: `5op_${letter}`, collectionId: COL_ID, edition: i + 1,
					owner: "alice", maxSupply: 5,
					metadata: { name: `5op ${letter.toUpperCase()}`, imageUrl: `https://example.com/5${letter}.png`, imageHash: `5${letter}h` },
				}, { txId: sharedTxId, operationId: `op_5_${i + 1}` }),
			);

			// Op 3 (index 2): invalid mint — bad collection, sits between valid ops
			const invalidOp = makeOp(ACTION_MINT, {
				id: invalidSeedId, artId: "5op_bad", collectionId: "col_nonexistent",
				edition: 1, owner: "alice", maxSupply: 1,
				metadata: { name: "Bad", imageUrl: "https://example.com/bad.png", imageHash: "bad" },
			}, { txId: sharedTxId, operationId: "op_5_3" });

			// Interleave: valid, valid, INVALID, valid, valid
			const allOps = [validOps[0]!, validOps[1]!, invalidOp, validOps[2]!, validOps[3]!];

			for (const op of allOps) {
				await routeOperation(op, sql);
			}

			// 4 valid NFTs created
			const nfts = await sql`SELECT id FROM nfts WHERE created_tx_id = ${sharedTxId} ORDER BY id`;
			expect(nfts.length).toBe(4);
			expect(nfts.map(n => n.id).sort()).toEqual([...validIds].sort());

			// 1 invalid recorded with correct operation_id
			const invalids = await sql`
				SELECT operation_id, reason FROM invalid_operations WHERE tx_id = ${sharedTxId}
			`;
			expect(invalids.length).toBe(1);
			expect(invalids[0]!.operation_id).toBe("op_5_3");
			expect(invalids[0]!.reason).toContain("not found");

			// Ghost NFT never created
			const [ghost] = await sql`SELECT id FROM nfts WHERE id = ${invalidSeedId}`;
			expect(ghost).toBeUndefined();
		});

		test("same operation replayed with different operation_id is idempotent", async () => {
			await seedCollection();
			const sharedTxId = "tx_replay_same_op";
			const replayDupId = await canonicalSeedId("replay_dup", COL_ID);

			// Same mint payload, two different operation_ids (simulating replay / duplicate broadcast)
			const mintData = {
				id: replayDupId, artId: "replay_dup", collectionId: COL_ID, edition: 1,
				owner: "alice", maxSupply: 5,
				metadata: { name: "Dup", imageUrl: "https://example.com/dup.png", imageHash: "duph" },
			};

			const op1 = makeOp(ACTION_MINT, mintData, { txId: sharedTxId, operationId: "op_dup_1" });
			const op2 = makeOp(ACTION_MINT, mintData, { txId: sharedTxId, operationId: "op_dup_2" });

			await routeOperation(op1, sql);
			await routeOperation(op2, sql);

			// Only 1 NFT should exist (nftExists check is by id, not operation_id)
			const nfts = await sql`SELECT id FROM nfts WHERE id = ${replayDupId}`;
			expect(nfts.length).toBe(1);

			// Second op should NOT be in invalid_operations (it returned early, not threw)
			const invalids = await sql`
				SELECT operation_id FROM invalid_operations WHERE tx_id = ${sharedTxId}
			`;
			expect(invalids.length).toBe(0);
		});
	});

	// ─── Scenario 4: Multiple txIds in the same block ───────

	describe("multiple transactions in the same block", () => {
		test("different signers can each mint in the same block", async () => {
			await seedCollection();
			const aliceSeedId = await canonicalSeedId("alice_block", COL_ID);

			// Alice mints in tx_A, bob creates collection + mints in tx_B, same block
			const aliceMint = makeOp(ACTION_MINT, {
				id: aliceSeedId,
				artId: "alice_block",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 5,
				metadata: { name: "Alice Block", imageUrl: "https://example.com/ab.png", imageHash: "abh" },
			}, { txId: "tx_alice_block", operationId: "op_alice_1", blockNum: SHARED_BLOCK });

			const bobColId = await generateDeterministicCollectionId("bob", "Bob Collection", "BOB");
			const bobSeedId = await canonicalSeedId("bob_block", bobColId);
			const bobCreate = makeOp(ACTION_CREATE_COLLECTION, {
				id: bobColId,
				name: "Bob Collection",
				symbol: "BOB",
				totalPotential: 50,
				metadata: { description: "Bob's", image: "https://example.com/bob.png" },
				rules: { transferable: true, burnable: true, royaltyPct: 0 },
			}, { signer: "bob", txId: "tx_bob_block", operationId: "op_bob_1", blockNum: SHARED_BLOCK });

			const bobMint = makeOp(ACTION_MINT, {
				id: bobSeedId,
				artId: "bob_block",
				collectionId: bobColId,
				edition: 1,
				owner: "bob",
				maxSupply: 5,
				metadata: { name: "Bob Block", imageUrl: "https://example.com/bb.png", imageHash: "bbh" },
			}, { signer: "bob", txId: "tx_bob_block", operationId: "op_bob_2", blockNum: SHARED_BLOCK });

			// All three in the same block, processed sequentially
			await handleMint(aliceMint, sql);
			await handleCreateCollection(bobCreate, sql);
			await handleMint(bobMint, sql);

			// Verify all created correctly
			const [aliceNft] = await sql`SELECT owner, created_block_num FROM nfts WHERE id = ${aliceSeedId}`;
			const [bobNft] = await sql`SELECT owner, created_block_num FROM nfts WHERE id = ${bobSeedId}`;
			expect(aliceNft!.owner).toBe("alice");
			expect(bobNft!.owner).toBe("bob");
			expect(Number(aliceNft!.created_block_num)).toBe(SHARED_BLOCK);
			expect(Number(bobNft!.created_block_num)).toBe(SHARED_BLOCK);
		});

		test("transfer chain within the same block (A→B then B→C)", async () => {
			await seedCollection();
			const chainId = await canonicalSeedId("chain", COL_ID);

			// Mint
			await handleMint(makeOp(ACTION_MINT, {
				id: chainId,
				artId: "chain",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 1,
				metadata: { name: "Chain", imageUrl: "https://example.com/c.png", imageHash: "ch" },
			}), sql);

			// Transfer A→B (tx_1 in block)
			await handleTransfer(makeOp(ACTION_TRANSFER, {
				nftId: chainId, to: "bob",
			}, { txId: "tx_chain_1", operationId: "op_chain_1", blockNum: SHARED_BLOCK }), sql);

			// Transfer B→C (tx_2 in same block, different tx)
			await handleTransfer(makeOp(ACTION_TRANSFER, {
				nftId: chainId, to: "charlie",
			}, { signer: "bob", txId: "tx_chain_2", operationId: "op_chain_2", blockNum: SHARED_BLOCK }), sql);

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = ${chainId}`;
			expect(nft!.owner).toBe("charlie");
		});
	});

	// ─── Scenario 5: Bulk distribute with shared tx_id ──────

	describe("bulk distribute multi-op idempotency", () => {
		test("bulk distribute + mint sharing tx_id do not collide", async () => {
			await seedCollection();
			const sharedTxId = "tx_bulk_mint_shared";
			const bulkSharedId = await canonicalSeedId("bulk_shared", COL_ID);

			// Op 1: mint a seed
			await handleMint(makeOp(ACTION_MINT, {
				id: bulkSharedId,
				artId: "bulk_shared",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 10,
				metadata: { name: "BulkShared", imageUrl: "https://example.com/bs.png", imageHash: "bsh" },
			}, { txId: sharedTxId, operationId: "op_bs_mint" }), sql);

			// Get the seed tx_id for bulk_distribute
			const [seedRow] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${bulkSharedId}`;
			const seedTxId = seedRow!.tx_id as string;

			// Op 2: bulk distribute from the same seed, same tx_id
			await handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [{ seedId: bulkSharedId, quantity: 2, seedTxId }],
			}, { txId: sharedTxId, operationId: "op_bs_dist" }), sql);

			// Should have 1 seed + 2 instances = 3 NFTs total
			const nfts = await sql`
				SELECT id, nft_type, created_tx_id AS tx_id FROM nfts
				WHERE collection_id = ${COL_ID}
				ORDER BY id
			`;
			expect(nfts.length).toBe(3);
			expect(nfts.filter(n => n.nft_type === "seed").length).toBe(1);
			expect(nfts.filter(n => n.nft_type === "instance").length).toBe(2);
			// All share the same tx_id
			expect(nfts.every(n => n.tx_id === sharedTxId)).toBe(true);
		});
	});

	// ─── Scenario 6: List + unlist in the same tx ───────────

	describe("list then unlist in the same tx", () => {
		test("list and immediate unlist in the same tx leaves NFT active", async () => {
			await seedCollection();
			const listUnlistId = await canonicalSeedId("list_unlist", COL_ID);

			// Mint first
			await handleMint(makeOp(ACTION_MINT, {
				id: listUnlistId,
				artId: "list_unlist",
				collectionId: COL_ID,
				edition: 1,
				owner: "alice",
				maxSupply: 1,
				metadata: { name: "ListUnlist", imageUrl: "https://example.com/lu.png", imageHash: "luh" },
			}), sql);

			const sharedTxId = "tx_list_unlist_same";

			const [seed] = await sql`SELECT created_tx_id AS tx_id FROM nfts WHERE id = ${listUnlistId}`;
			await handleBulkDistribute(makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [{ seedId: listUnlistId, quantity: 1, seedTxId: seed!.tx_id }],
			}), sql);
			const [instance] = await sql`SELECT id FROM nfts WHERE seed_id = ${listUnlistId} LIMIT 1`;
			const instanceId = instance!.id as string;

			// Op 1: list
			const listData = await makeListData(instanceId);
			await handleList(makeOp(ACTION_LIST, listData, {
				txId: sharedTxId, operationId: "op_list",
			}), sql);

			// Op 2: unlist (same tx_id, different operation_id)
			await handleUnlist(makeOp(ACTION_UNLIST, { nftId: instanceId }, {
				txId: sharedTxId, operationId: "op_unlist",
			}), sql);

			const [nft] = await sql`SELECT status, listing_price FROM nfts WHERE id = ${instanceId}`;
			expect(nft!.status).toBe("active");
			expect(nft!.listing_price).toBeNull();
		});
	});
});

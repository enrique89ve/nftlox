import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, type Queryable } from "@/db/client.ts";
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
import { handleReplicate } from "@/processor/handlers/core/replicate.ts";
import { handleNftLend } from "@/processor/handlers/lending/nft-lend.ts";
import { handleNftReturn } from "@/processor/handlers/lending/nft-return.ts";
import { handlePackCreate } from "@/processor/handlers/packs/pack-create.ts";
import { handlePackBuy } from "@/processor/handlers/packs/pack-buy.ts";
import { handlePackOpen } from "@/processor/handlers/packs/pack-open.ts";
import { handlePackApprove } from "@/processor/handlers/allowances/pack-approve.ts";
import { handleDataOperatorApprove } from "@/processor/handlers/allowances/data-operator-approve.ts";
import { listCollections } from "@/db/queries/collections.ts";
import {
	ACTION_CREATE_COLLECTION,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_SET_DATA,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_REPLICATE,
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_OPEN,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_PACK_APPROVE,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_BUY,
	calculatePaymentSplit,
	ACTIVE_AUTH_ACTIONS,
	generateListingNonce,
	generateListingId,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	generateDeterministicCollectionId,
} from "nftlox-sdk";

const ACTIVE_SET = new Set<string>(ACTIVE_AUTH_ACTIONS);

// Canonical collection ID for alice + "Test Collection" + "TEST"
let COL_ID: string;

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
	await sql`DELETE FROM pack_allowances`;
	await sql`DELETE FROM user_pack_balances`;
	await sql`DELETE FROM packs`;
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM collection_stats`;
	await sql`DELETE FROM collections`;
}

async function seedCollection(txn: Queryable = sql) {
	const op = makeOp(ACTION_CREATE_COLLECTION, {
		id: COL_ID,
		name: "Test Collection",
		symbol: "TEST",
		totalPotential: 1000,
		metadata: { description: "A test collection", image: "https://example.com/img.png" },
		rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 5 },
	});
	await handleCreateCollection(op, txn);
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
			rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 0 },
			...overrides,
		},
	};
}

async function seedMint(txn: Queryable = sql) {
	const op = makeOp(ACTION_MINT, {
		id: "seed_test1",
		collectionId: COL_ID,
		edition: 1,
		owner: "alice",
		maxReplicas: 10,
		metadata: { name: "Test Seed", imageUrl: "https://example.com/nft.png", imageHash: "img_abc" },
	});
	await handleMint(op, txn);
}

/**
 * Creates an instance from seed_test1 via bulk_distribute.
 * Returns the deterministic instance ID (nft_test1_1_...).
 * Requires seedCollection() + seedMint() to have been called first.
 */
async function seedInstance(txn: Queryable = sql): Promise<string> {
	const seedTxId = await getSeedTxId("seed_test1");
	const op = makeOp(ACTION_BULK_DISTRIBUTE, {
		items: [{ seedId: "seed_test1", quantity: 1, seedTxId }],
	});
	await handleBulkDistribute(op, txn);
	const [inst] = await txn`SELECT id FROM nfts WHERE seed_id = 'seed_test1' LIMIT 1`;
	return inst!.id as string;
}

async function makeBulkItem(seedId: string, quantity: number, seedTxId?: string) {
	const txId = seedTxId ?? await getSeedTxId(seedId);
	return { seedId, quantity, seedTxId: txId };
}

async function getSeedTxId(seedId: string): Promise<string> {
	const [row] = await sql`SELECT tx_id FROM nfts WHERE id = ${seedId}`;
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
		// Drop all tables to ensure clean schema (testnet only)
		await sql.unsafe(`
			DROP TABLE IF EXISTS nft_loans, nft_allowances, collection_allowances,
				pack_allowances, user_pack_balances, data_operators,
				orphaned_buys, invalid_operations, owner_nft_counts,
				collection_stats,
				nfts, packs, collections, sync_state CASCADE
		`);
		await sql.unsafe("DROP TYPE IF EXISTS nft_kind, nft_status, pack_status CASCADE");
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
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: "col_fake_id_12345",
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 0 },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("Non-canonical collectionId");
		});

		test("computes originDna canonically, ignoring payload value", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				originDna: "FAKE_ORIGIN_DNA",
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 0 },
			});
			await handleCreateCollection(op, sql);
			const [row] = await sql`SELECT origin_dna FROM collections WHERE id = ${COL_ID}`;
			expect(row!.origin_dna).not.toBe("FAKE_ORIGIN_DNA");
			expect(row!.origin_dna).toBeTruthy();
		});

		test("rejects missing metadata", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 0 },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("metadata");
		});

		test("rejects missing metadata.description", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 0 },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("metadata.description");
		});

		test("rejects missing rules", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("rules");
		});

		test("rejects missing rules.transferable", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { burnable: true, replicable: true, royaltyPct: 0 },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("rules.transferable");
		});

		test("rejects royaltyPct out of range", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: 100,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 60 },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("royaltyPct");
		});

		test("rejects negative totalPotential", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: COL_ID,
				name: "Test Collection",
				symbol: "TEST",
				totalPotential: -5,
				metadata: { description: "Test", image: "https://example.com/img.png" },
				rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 0 },
			});
			await expect(handleCreateCollection(op, sql)).rejects.toThrow("totalPotential");
		});
	});

	// ─── archive_collection ─────────────────────────

	describe("archive_collection", () => {
		test("archives an empty collection, clears collection-scoped permissions, and hides it from lists", async () => {
			await seedCollection();

			await handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "bob",
				collectionId: COL_ID,
				approved: true,
			}), sql);
			await handleDataOperatorApprove(makeOp(ACTION_DATA_OPERATOR_APPROVE, {
				collectionId: COL_ID,
				operator: "carol",
				approved: true,
			}), sql);

			await handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
				collectionId: COL_ID,
			}), sql);

			const [collection] = await sql`
				SELECT status, archived_at_block, archived_tx_id
				FROM collections
				WHERE id = ${COL_ID}
			`;
			expect(collection).toBeDefined();
			expect(collection!.status).toBe("archived");
			expect(Number(collection!.archived_at_block)).toBe(90000100);
			expect(collection!.archived_tx_id).toContain("archive_collection");

			const [allowances] = await sql`
				SELECT COUNT(*)::int AS count FROM collection_allowances WHERE collection_id = ${COL_ID}
			`;
			const [operators] = await sql`
				SELECT COUNT(*)::int AS count FROM data_operators WHERE collection_id = ${COL_ID}
			`;
			expect(Number(allowances!.count)).toBe(0);
			expect(Number(operators!.count)).toBe(0);

			const visibleCollections = await listCollections();
			expect(visibleCollections.some((row) => row.id === COL_ID)).toBe(false);
		});

		test("rejects archive when NFTs already exist", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
					collectionId: COL_ID,
				}), sql),
			).rejects.toThrow("NFTs still exist");
		});

		test("rejects archive when packs already exist", async () => {
			await seedCollection();
			await sql`
				INSERT INTO packs (
					id, collection_id, creator, name, description, image_url,
					drop_table, items_per_pack,
					price_amount, price_currency,
					max_supply, current_supply, total_opened, status,
					block_num, tx_id, created_at
				) VALUES (
					'pack_orphan', ${COL_ID}, 'alice', 'Pack',
					NULL, NULL, '[]'::jsonb, 1,
					NULL, NULL,
					0, 0, 0, 'active',
					90000100, 'tx_pack_orphan', '2024-01-01T00:00:00'
				)
			`;

			await expect(
				handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
					collectionId: COL_ID,
				}), sql),
			).rejects.toThrow("packs still exist");
		});

		test("rejects archive from non-creator signer", async () => {
			await seedCollection();

			await expect(
				handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
					collectionId: COL_ID,
				}, "eve"), sql),
			).rejects.toThrow("is not creator");
		});

		test("mint rejects archived collection", async () => {
			await seedCollection();
			await handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
				collectionId: COL_ID,
			}), sql);

			await expect(
				handleMint(makeOp(ACTION_MINT, {
					id: "seed_after_archive",
					collectionId: COL_ID,
					metadata: { name: "After Archive" },
				}), sql),
			).rejects.toThrow("is archived");
		});

		test("pack_create rejects archived collection", async () => {
			await seedCollection();
			await handleArchiveCollection(makeOp(ACTION_ARCHIVE_COLLECTION, {
				collectionId: COL_ID,
			}), sql);

			await expect(
				handlePackCreate(makeOp(ACTION_PACK_CREATE, {
					id: "pack_archived",
					collectionId: COL_ID,
					name: "Archived Pack",
					dropTable: [{ seedId: "seed_missing", weight: 1 }],
					itemsPerPack: 1,
					maxSupply: 0,
				}), sql),
			).rejects.toThrow("is archived");
		});
	});

	// ─── mint ───────────────────────────────────────

	describe("mint", () => {
		test("mints a seed NFT", async () => {
			await seedCollection();
			await seedMint();
			const [nft] = await sql`SELECT * FROM nfts WHERE id = 'seed_test1'`;
			expect(nft).toBeDefined();
			expect(nft!.nft_type).toBe("seed");
			expect(nft!.owner).toBe("alice");
			expect(nft!.max_replicas).toBe(10);
		});

		test("rejects mint without collection", async () => {
			const op = makeOp(ACTION_MINT, {
				id: "seed_orphan",
				collectionId: "col_nonexistent",
				metadata: { name: "Test" },
			});
			await expect(handleMint(op, sql)).rejects.toThrow("Collection not found");
		});

		test("duplicate mint is idempotent no-op", async () => {
			await seedCollection();
			await seedMint();
			await expect(seedMint()).resolves.toBeUndefined();
		});

		test("always computes DNA internally, ignoring user-supplied values", async () => {
			await seedCollection();
			const op = makeOp(ACTION_MINT, {
				id: "seed_dna_test",
				collectionId: COL_ID,
				edition: 1,
				originDna: "FAKE_ORIGIN_DNA",
				instanceDna: "FAKE_INSTANCE_DNA",
				uniqueAccessKey: "FAKEKEY1",
				metadata: { name: "DNA Test", imageHash: "hash_abc" },
			});
			await handleMint(op, sql);

			const [nft] = await sql`SELECT origin_dna, instance_dna, unique_access_key FROM nfts WHERE id = 'seed_dna_test'`;
			expect(nft).toBeDefined();
			// Must NOT be the fake values
			expect(nft!.origin_dna).not.toBe("FAKE_ORIGIN_DNA");
			expect(nft!.instance_dna).not.toBe("FAKE_INSTANCE_DNA");
			expect(nft!.unique_access_key).not.toBe("FAKEKEY1");
			// Must be non-null (computed)
			expect(nft!.origin_dna).toBeTruthy();
			expect(nft!.instance_dna).toBeTruthy();
			expect(nft!.unique_access_key).toBeTruthy();
		});

		test("mint DNA is deterministic across replays", async () => {
			await seedCollection();

			const op1 = makeOp(ACTION_MINT, {
				id: "seed_replay_dna",
				collectionId: COL_ID,
				metadata: { name: "Replay", imageHash: "hash_xyz" },
			});
			// Force same txId for both calls
			(op1 as any).txId = "tx_fixed_replay";
			await handleMint(op1, sql);

			const [nft1] = await sql`SELECT instance_dna FROM nfts WHERE id = 'seed_replay_dna'`;

			// Clean and replay with same txId
			await sql`DELETE FROM nfts WHERE id = 'seed_replay_dna'`;
			const op2 = makeOp(ACTION_MINT, {
				id: "seed_replay_dna",
				collectionId: COL_ID,
				metadata: { name: "Replay", imageHash: "hash_xyz" },
			});
			(op2 as any).txId = "tx_fixed_replay";
			await handleMint(op2, sql);

			const [nft2] = await sql`SELECT instance_dna FROM nfts WHERE id = 'seed_replay_dna'`;
			expect(nft1!.instance_dna).toBe(nft2!.instance_dna);
		});

		test("rejects direct instance mint", async () => {
			await seedCollection();

			const instOp = makeOp(ACTION_MINT, {
				id: "nft_bbb_1_ccc",
				collectionId: COL_ID,
				metadata: { name: "Instance" },
			});
			await expect(handleMint(instOp, sql)).rejects.toThrow(
				"Only seeds can be minted directly",
			);
		});

		test("rejects explicit nftType instance", async () => {
			await seedCollection();

			const op = makeOp(ACTION_MINT, {
				id: "seed_explicit_inst",
				collectionId: COL_ID,
				nftType: "instance",
				metadata: { name: "Fake Instance" },
			});
			await expect(handleMint(op, sql)).rejects.toThrow(
				"Only seeds can be minted directly",
			);
		});

		test("uniqueAccessKey is derived from owner, not signer", async () => {
			await seedCollection();

			const op = makeOp(ACTION_MINT, {
				id: "seed_owner_key",
				collectionId: COL_ID,
				owner: "bob",
				metadata: { name: "Owner Key Test" },
			});
			await handleMint(op, sql);

			// Mint same seed with signer as owner to compare
			const op2 = makeOp(ACTION_MINT, {
				id: "seed_signer_key",
				collectionId: COL_ID,
				metadata: { name: "Signer Key Test" },
			});
			await handleMint(op2, sql);

			const [nftBob] = await sql`SELECT unique_access_key FROM nfts WHERE id = 'seed_owner_key'`;
			const [nftAlice] = await sql`SELECT unique_access_key FROM nfts WHERE id = 'seed_signer_key'`;
			// Keys must differ because owners differ (bob vs alice)
			expect(nftBob!.unique_access_key).not.toBe(nftAlice!.unique_access_key);
		});
	});

	// ─── bulk_distribute ────────────────────────────

	describe("bulk_distribute", () => {
		test("distributes instances from seed", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 3)],
			});
			await handleBulkDistribute(op, sql);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_test1' ORDER BY instance_number`;
			expect(instances.length).toBe(3);
			expect(instances[0]!.owner).toBe("bob");
			expect(instances[0]!.nft_type).toBe("instance");
			expect(instances[2]!.instance_number).toBe(3);

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_test1'`;
			expect(seed!.distributed).toBe(3);
		});

		test("distributed instances always have non-null DNA and access keys", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 2)],
			});
			await handleBulkDistribute(op, sql);

			const instances = await sql`
				SELECT origin_dna, instance_dna, unique_access_key
				FROM nfts WHERE seed_id = 'seed_test1' ORDER BY instance_number
			`;
			for (const inst of instances) {
				expect(inst.origin_dna).toBeTruthy();
				expect(inst.instance_dna).toBeTruthy();
				expect(inst.unique_access_key).toBeTruthy();
			}
			// Different instances should have different DNA
			expect(instances[0]!.instance_dna).not.toBe(instances[1]!.instance_dna);
		});

		test("rejects distribute by non-owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 1)],
			}, "eve");
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("is not the owner of seed");
		});

		test("rejects distribute over max supply", async () => {
			await seedCollection();

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_limited",
				collectionId: COL_ID,
				maxReplicas: 2,
				metadata: { name: "Limited" },
			});
			await handleMint(mintOp, sql);

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_limited", 3)],
			});
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("insufficient supply");
		});

		test("rejects duplicate seedId in items", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [
					await makeBulkItem("seed_test1", 1),
					await makeBulkItem("seed_test1", 1),
				],
			});
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("Duplicate seedId");
		});

		test("rejects invalid seedTxId", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
			});
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("Invalid seedTxId");
		});

		test("rejects missing seedTxId", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_test1", quantity: 1 }],
			});
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("seedTxId");
		});

		test("idempotent on reprocess (same tx)", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 2)],
			});
			await handleBulkDistribute(op, sql);

			// Reprocess same op — should skip existing, mint 0
			await handleBulkDistribute(op, sql);

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_test1'`;
			expect(seed!.distributed).toBe(2); // not 4
		});

		test("defaults to signer when no 'to' provided", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [await makeBulkItem("seed_test1", 1)],
			});
			await handleBulkDistribute(op, sql);

			const [inst] = await sql`SELECT owner FROM nfts WHERE seed_id = 'seed_test1'`;
			expect(inst!.owner).toBe("alice");
		});

		test("uniqueAccessKey is derived from recipient (to), not signer", async () => {
			await seedCollection();
			await seedMint();

			// Distribute to bob (signer=alice, to=bob)
			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 1)],
			});
			await handleBulkDistribute(op, sql);

			// Distribute to alice (signer=alice, no to = defaults to alice)
			const mintOp2 = makeOp(ACTION_MINT, {
				id: "seed_test2",
				collectionId: COL_ID,
				maxReplicas: 10,
				metadata: { name: "Seed 2" },
			});
			await handleMint(mintOp2, sql);

			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [await makeBulkItem("seed_test2", 1)],
			});
			await handleBulkDistribute(op2, sql);

			const [instBob] = await sql`SELECT unique_access_key FROM nfts WHERE seed_id = 'seed_test1' AND nft_type = 'instance'`;
			const [instAlice] = await sql`SELECT unique_access_key FROM nfts WHERE seed_id = 'seed_test2' AND nft_type = 'instance'`;

			// Keys must differ because recipients differ (bob vs alice),
			// even though both operations were signed by alice
			expect(instBob!.unique_access_key).not.toBe(instAlice!.unique_access_key);
		});

		test("only owner can distribute — creator without ownership is rejected", async () => {
			await seedCollection(); // creator = alice

			// Mint seed owned by bob (alice is creator, mints for bob)
			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_bob",
				collectionId: COL_ID,
				owner: "bob",
				maxReplicas: 10,
				metadata: { name: "Bob Seed" },
			}, "alice");
			await handleMint(mintOp, sql);

			// Alice (creator but NOT owner) tries to distribute — must be rejected
			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [await makeBulkItem("seed_bob", 2)],
			}, "alice");
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("is not the owner of seed");

			// Bob (owner) can distribute
			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [await makeBulkItem("seed_bob", 2)],
			}, "bob");
			await handleBulkDistribute(op2, sql);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_bob'`;
			expect(instances.length).toBe(2);
			expect(instances[0]!.owner).toBe("charlie");
		});

		// ─── idempotency tests ─────────────────────

		test("idempotent on reprocess — instances unchanged", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 2)],
			});
			await handleBulkDistribute(op, sql);
			await handleBulkDistribute(op, sql);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_test1' ORDER BY instance_number`;
			expect(instances.length).toBe(2); // not 4
			expect(instances[0]!.instance_number).toBe(1);
			expect(instances[1]!.instance_number).toBe(2);
		});

		test("sequential distributes produce sequential instance numbers", async () => {
			await seedCollection();
			await seedMint();

			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_test1", 2)],
			});
			await handleBulkDistribute(op1, sql);

			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [await makeBulkItem("seed_test1", 3)],
			});
			await handleBulkDistribute(op2, sql);

			const instances = await sql`SELECT instance_number, owner FROM nfts WHERE seed_id = 'seed_test1' ORDER BY instance_number`;
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
				items: [await makeBulkItem("seed_test1", 3)],
			});
			await handleBulkDistribute(op, sql);

			// Delete one instance to simulate partial state
			await sql`DELETE FROM nfts WHERE instance_number = 2 AND seed_id = 'seed_test1'`;
			await sql`UPDATE nfts SET distributed = distributed - 1 WHERE id = 'seed_test1'`;

			// Replay should recreate only the missing instance
			await handleBulkDistribute(op, sql);

			const instances = await sql`SELECT instance_number FROM nfts WHERE seed_id = 'seed_test1' ORDER BY instance_number`;
			expect(instances.length).toBe(3);
			expect(instances.map(i => i.instance_number)).toEqual([1, 2, 3]);
		});

		test("supply check uses pre-tx distributed count", async () => {
			await seedCollection();

			// Seed with max 3 replicas
			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_capped",
				collectionId: COL_ID,
				maxReplicas: 3,
				metadata: { name: "Capped" },
			});
			await handleMint(mintOp, sql);

			// Distribute 2
			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_capped", 2)],
			});
			await handleBulkDistribute(op1, sql);

			// Replay of op1 should NOT throw (baseDistributed=0, quantity=2, max=3 — OK)
			await handleBulkDistribute(op1, sql);

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_capped'`;
			expect(seed!.distributed).toBe(2);
		});

		test("multi-seed bulk distribute is idempotent", async () => {
			await seedCollection();
			await seedMint(); // seed_test1

			const mintOp2 = makeOp(ACTION_MINT, {
				id: "seed_test2",
				collectionId: COL_ID,
				maxReplicas: 10,
				metadata: { name: "Seed 2" },
			});
			await handleMint(mintOp2, sql);

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [
					await makeBulkItem("seed_test1", 2),
					await makeBulkItem("seed_test2", 3),
				],
			});
			await handleBulkDistribute(op, sql);
			await handleBulkDistribute(op, sql);

			const inst1 = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_test1'`;
			const inst2 = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_test2'`;
			expect(inst1.length).toBe(2);
			expect(inst2.length).toBe(3);

			const [s1] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_test1'`;
			const [s2] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_test2'`;
			expect(s1!.distributed).toBe(2);
			expect(s2!.distributed).toBe(3);
		});

		// ─── concurrency / parallel distribution tests ─

		test("concurrent distributes from same seed maintain correct distributed count", async () => {
			await seedCollection();

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_concurrent",
				collectionId: COL_ID,
				maxReplicas: 20,
				metadata: { name: "Concurrent Seed" },
			});
			await handleMint(mintOp, sql);

			// 5 different transactions, each distributing 2 instances, run sequentially
			// (simulates blockchain order — ops arrive one after another)
			const testUsers = ["user-aaa", "user-bbb", "user-ccc", "user-ddd", "user-eee"];
			for (let t = 0; t < 5; t++) {
				const op = makeOp(ACTION_BULK_DISTRIBUTE, {
					to: testUsers[t],
					items: [await makeBulkItem("seed_concurrent", 2)],
				});
				// Override txId to make each unique
				(op as any).txId = `tx_concurrent_${t}`;
				await handleBulkDistribute(op, sql);
			}

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_concurrent'`;
			expect(seed!.distributed).toBe(10);

			const instances = await sql`
				SELECT instance_number, owner FROM nfts
				WHERE seed_id = 'seed_concurrent'
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

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_race",
				collectionId: COL_ID,
				maxReplicas: 5,
				metadata: { name: "Race Seed" },
			});
			await handleMint(mintOp, sql);

			// Distribute 3 first
			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "alice",
				items: [await makeBulkItem("seed_race", 3)],
			});
			(op1 as any).txId = "tx_race_1";
			await handleBulkDistribute(op1, sql);

			// Now try to distribute 3 more — should fail (only 2 remaining)
			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [await makeBulkItem("seed_race", 3)],
			});
			(op2 as any).txId = "tx_race_2";
			await expect(handleBulkDistribute(op2, sql)).rejects.toThrow("insufficient supply");

			// Distributed counter should still be 3
			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_race'`;
			expect(seed!.distributed).toBe(3);
		});

		test("concurrent distributes then replay — all idempotent", async () => {
			await seedCollection();

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_replay_multi",
				collectionId: COL_ID,
				maxReplicas: 10,
				metadata: { name: "Replay Multi" },
			});
			await handleMint(mintOp, sql);

			const replayUsers = ["user-aaa", "user-bbb", "user-ccc"];
			const bulkItem = await makeBulkItem("seed_replay_multi", 2);
			const ops = Array.from({ length: 3 }, (_, t) => {
				const op = makeOp(ACTION_BULK_DISTRIBUTE, {
					to: replayUsers[t],
					items: [bulkItem],
				});
				(op as any).txId = `tx_replay_multi_${t}`;
				return op;
			});

			// First pass — all 3 distribute normally
			for (const op of ops) await handleBulkDistribute(op, sql);

			// Replay all 3 — nothing should change
			for (const op of ops) await handleBulkDistribute(op, sql);

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_replay_multi'`;
			expect(seed!.distributed).toBe(6);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_replay_multi'`;
			expect(instances.length).toBe(6);
		});

	});

	// ─── transfer ───────────────────────────────────

	describe("transfer", () => {
		test("transfers NFT to new owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await handleTransfer(op, sql);

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("bob");
		});

		test("rejects transfer by non-owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" }, "eve");
			await expect(handleTransfer(op, sql)).rejects.toThrow("not owner");
		});

		test("rejects transfer of burned NFT", async () => {
			await seedCollection();
			await seedMint();
			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("burned");
		});

		test("rejects transfer of listed NFT", async () => {
			await seedCollection();
			await seedMint();
			const listData = await makeListData({ nftId: "seed_test1" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("listed for sale");
		});

		test("allows transfer of NFT with expired listing", async () => {
			await seedCollection();
			await seedMint();
			// Set listing that expires before the block timestamp used in makeOp
			const blockTime = new Date("2024-01-01T00:00:00").getTime();
			const pastExpiry = blockTime - 60_000;
			const listData = await makeListData({ nftId: "seed_test1", expiresAt: pastExpiry });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await handleTransfer(op, sql);

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("bob");
		});

		test("rejects transfer from non-transferable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "Locked Collection", "LOCK",
				{ rules: { transferable: false, burnable: true, replicable: true, royaltyPct: 0 } },
			);
			await handleCreateCollection(makeOp(ACTION_CREATE_COLLECTION, colData), sql);

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_locked1",
				collectionId: colId,
				metadata: { name: "Locked Seed" },
			});
			await handleMint(mintOp, sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_locked1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("not transferable");
		});

		test("rejects transfer of non-existent NFT", async () => {
			const op = makeOp(ACTION_TRANSFER, { nftId: "nft_ghost", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("not found");
		});

		test("rejects transfer of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: instId, to: "charlie" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("lent");
		});
	});

	// ─── burn ───────────────────────────────────────

	describe("burn", () => {
		test("burns NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql);

			const [nft] = await sql`SELECT status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.status).toBe("burned");
		});

		test("rejects double burn", async () => {
			await seedCollection();
			await seedMint();
			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql);
			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql),
			).rejects.toThrow("NFT is burned");
		});

		test("rejects burn of non-existent NFT", async () => {
			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "nft_ghost", to: "null" }), sql),
			).rejects.toThrow("not found");
		});

		test("rejects burn from non-burnable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Burn", "NOBRN",
				{ rules: { transferable: true, burnable: false, replicable: true, royaltyPct: 0 } },
			);
			await handleCreateCollection(makeOp(ACTION_CREATE_COLLECTION, colData), sql);
			await handleMint(makeOp(ACTION_MINT, {
				id: "seed_noburn1", collectionId: colId, metadata: { name: "No Burn Seed" },
			}), sql);

			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_noburn1", to: "null" }), sql),
			).rejects.toThrow("does not allow burning");
		});

		test("rejects burn of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), sql);

			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), sql),
			).rejects.toThrow("lent");
		});

		test("rejects burn of listed NFT", async () => {
			await seedCollection();
			await seedMint();
			const listData = await makeListData({ nftId: "seed_test1" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql),
			).rejects.toThrow("listed");
		});
	});

	// ─── list / unlist / buy ────────────────────────

	describe("marketplace", () => {
		test("list → unlist cycle", async () => {
			await seedCollection();
			await seedMint();

			const listData = await makeListData({ nftId: "seed_test1" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const [listed] = await sql`SELECT status, listing_price, listing_currency FROM nfts WHERE id = 'seed_test1'`;
			expect(listed!.status).toBe("listed");
			expect(Number(listed!.listing_price)).toBe(10);
			expect(listed!.listing_currency).toBe("HIVE");

			await handleUnlist(makeOp(ACTION_UNLIST, { nftId: "seed_test1" }), sql);

			const [unlisted] = await sql`SELECT status, listing_price FROM nfts WHERE id = 'seed_test1'`;
			expect(unlisted!.status).toBe("active");
			expect(unlisted!.listing_price).toBeNull();
		});

		test("rejects list for non-transferable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Transfer Collection", "NOTX",
				{ rules: { transferable: false, burnable: true, replicable: true, royaltyPct: 0 } },
			);
			await handleCreateCollection(makeOp(ACTION_CREATE_COLLECTION, colData), sql);

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_notransfer1",
				collectionId: colId,
				metadata: { name: "Locked Seed" },
			});
			await handleMint(mintOp, sql);

			const listData = await makeListData({ nftId: "seed_notransfer1" });
			await expect(
				handleList(makeOp(ACTION_LIST, listData), sql),
			).rejects.toThrow("not transferable");
		});

		test("buy rejects non-transferable collection", async () => {
			// Create non-transferable collection and mint a seed
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Buy Collection", "NOBUY",
				{ rules: { transferable: false, burnable: true, replicable: true, royaltyPct: 0 } },
			);
			await handleCreateCollection(makeOp(ACTION_CREATE_COLLECTION, colData), sql);

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_nobuy1",
				collectionId: colId,
				metadata: { name: "No Buy Seed" },
			});
			await handleMint(mintOp, sql);

			// Force-list via SQL (bypassing the list handler's transferable check)
			// to test the buy handler's own guard
			const listData = await makeListData({ nftId: "seed_nobuy1" });
			await sql`
				UPDATE nfts
				SET status = 'listed',
					listing_id = ${listData.listingId as string},
					listing_tx_id = 'tx_fake_list',
					listing_price = 10,
					listing_currency = 'HIVE'
				WHERE id = 'seed_nobuy1'
			`;

			const nodeAccount = config.hiveAccount;
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "bob", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}seed_nobuy1` },
				{ from: "bob", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}seed_nobuy1` },
			];

			const buyOp = makeOp(ACTION_BUY, {
				nftId: "seed_nobuy1",
				listingId: listData.listingId,
				listTxId: "tx_fake_list",
				txId: mintOp.txId,
			}, nodeAccount, transfers);

			await expect(handleBuy(buyOp, sql)).rejects.toThrow("not transferable");
		});

		test("rejects list of burned NFT", async () => {
			await seedCollection();
			await seedMint();
			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql);

			const listData = await makeListData({ nftId: "seed_test1" });
			await expect(
				handleList(makeOp(ACTION_LIST, listData), sql),
			).rejects.toThrow("burned");
		});

		test("rejects list of non-existent NFT", async () => {
			const listData = await makeListData({ nftId: "nft_ghost" });
			await expect(
				handleList(makeOp(ACTION_LIST, listData), sql),
			).rejects.toThrow("not found");
		});

		test("rejects double list with active listing", async () => {
			await seedCollection();
			await seedMint();

			const listData1 = await makeListData({ nftId: "seed_test1" });
			await handleList(makeOp(ACTION_LIST, listData1), sql);

			const listData2 = await makeListData({ nftId: "seed_test1", priceAmount: "20.000" });
			await expect(
				handleList(makeOp(ACTION_LIST, listData2), sql),
			).rejects.toThrow("already listed");
		});

		test("rejects unlist of unlisted NFT", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				handleUnlist(makeOp(ACTION_UNLIST, { nftId: "seed_test1" }), sql),
			).rejects.toThrow("not listed");
		});

		test("rejects unlist by non-owner", async () => {
			await seedCollection();
			await seedMint();
			const listData = await makeListData({ nftId: "seed_test1" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			await expect(
				handleUnlist(makeOp(ACTION_UNLIST, { nftId: "seed_test1" }, "eve"), sql),
			).rejects.toThrow("not owner");
		});

	});

	// ─── lending ────────────────────────────────────

	describe("nft_lend / nft_return", () => {
		test("lend sets status to lent", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			const [nft] = await sql`SELECT status, owner FROM nfts WHERE id = ${instId}`;
			expect(nft!.status).toBe("lent");
			expect(nft!.owner).toBe("alice"); // owner unchanged
		});

		test("lend creates loan record", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			const [loan] = await sql`SELECT * FROM nft_loans WHERE nft_id = ${instId}`;
			expect(loan).toBeDefined();
			expect(loan!.lender).toBe("alice");
			expect(loan!.borrower).toBe("bob");
		});

		test("return restores active status", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			await handleNftReturn(makeOp(ACTION_NFT_RETURN, {
				instanceId: instId,
			}), sql); // alice (lender) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = ${instId}`;
			expect(nft!.status).toBe("active");

			const [loan] = await sql`SELECT * FROM nft_loans WHERE nft_id = ${instId}`;
			expect(loan).toBeUndefined();
		});

		test("borrower can return", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			await handleNftReturn(makeOp(ACTION_NFT_RETURN, {
				instanceId: instId,
			}, "bob"), sql); // bob (borrower) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = ${instId}`;
			expect(nft!.status).toBe("active");
		});

		test("rejects lend to yourself", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: "seed_test1",
					borrower: "alice",
				}), sql),
			).rejects.toThrow("Cannot lend to yourself");
		});

		test("rejects lend by non-owner", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: instId,
					borrower: "charlie",
				}, "eve"), sql),
			).rejects.toThrow("not owner");
		});

		test("rejects double lend", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: instId,
					borrower: "charlie",
				}), sql),
			).rejects.toThrow("must be active");
		});

		test("rejects return by stranger", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			await expect(
				handleNftReturn(makeOp(ACTION_NFT_RETURN, {
					instanceId: instId,
				}, "eve"), sql),
			).rejects.toThrow("neither lender nor borrower");
		});

		// ─── lent guards ────────────────────────────

		test("rejects transfer of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, {
					nftId: instId,
					to: "charlie",
				}), sql),
			).rejects.toThrow("lent");
		});

		test("rejects burn of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), sql),
			).rejects.toThrow("lent");
		});

		test("rejects list of lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId,
				borrower: "bob",
			}), sql);

			const listData = await makeListData({ nftId: instId });
			await expect(
				handleList(makeOp(ACTION_LIST, listData), sql),
			).rejects.toThrow("lent");
		});

		test("rejects lend of burned NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), sql);

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), sql),
			).rejects.toThrow("must be active");
		});

		test("rejects lend of non-existent NFT", async () => {
			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: "nft_ghost", borrower: "bob" }), sql),
			).rejects.toThrow("not found");
		});

		test("rejects lend from non-transferable collection", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "No Lend", "NOLND",
				{ rules: { transferable: false, burnable: true, replicable: true, royaltyPct: 0 } },
			);
			await handleCreateCollection(makeOp(ACTION_CREATE_COLLECTION, colData), sql);
			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_nolend1", collectionId: colId, maxReplicas: 10,
				metadata: { name: "No Lend Seed" },
			});
			await handleMint(mintOp, sql);

			// Distribute an instance from the seed to test lend on an instance
			const nolendTxId = await getSeedTxId("seed_nolend1");
			const distOp = makeOp(ACTION_BULK_DISTRIBUTE, {
				items: [{ seedId: "seed_nolend1", quantity: 1, seedTxId: nolendTxId }],
			});
			await handleBulkDistribute(distOp, sql);
			const [inst] = await sql`SELECT id FROM nfts WHERE seed_id = 'seed_nolend1' LIMIT 1`;

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: inst!.id, borrower: "bob" }), sql),
			).rejects.toThrow("not transferable");
		});

		test("rejects return of non-lent (active) NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await expect(
				handleNftReturn(makeOp(ACTION_NFT_RETURN, { instanceId: instId }), sql),
			).rejects.toThrow("not lent");
		});
	});

	// ─── pack_open (distributed control) ───────────

	describe("pack_open", () => {
		// Helper: create a seed with high capacity for pack testing
		async function seedForPack(id: string, maxReplicas = 10000) {
			const op = makeOp(ACTION_MINT, {
				id,
				collectionId: COL_ID,
				maxReplicas,
				metadata: { name: `Pack Seed ${id}` },
			});
			await handleMint(op, sql);
		}

		// Helper: create pack and give balance directly via SQL
		async function setupPack(opts: {
			packId: string;
			seedIds: string[];
			itemsPerPack?: number;
			maxSupply?: number;
			buyQuantity: number;
			buyer?: string;
		}) {
			const dropTable = opts.seedIds.map(seedId => ({ seedId, weight: 1 }));
			const createOp = makeOp(ACTION_PACK_CREATE, {
				id: opts.packId,
				collectionId: COL_ID,
				name: `Pack ${opts.packId}`,
				dropTable,
				itemsPerPack: opts.itemsPerPack ?? 1,
				maxSupply: opts.maxSupply ?? 10000,
			});
			await handlePackCreate(createOp, sql);

			// Insert balance directly — avoids pack_buy payment flow in tests
			const buyer = opts.buyer ?? "bob";
			await sql`
				INSERT INTO user_pack_balances (account, pack_id, balance)
				VALUES (${buyer}, ${opts.packId}, ${opts.buyQuantity})
				ON CONFLICT (account, pack_id)
				DO UPDATE SET balance = user_pack_balances.balance + ${opts.buyQuantity}
			`;
		}

		test("opens a pack and mints instances", async () => {
			await seedCollection();
			await seedForPack("seed_p1");

			await setupPack({ packId: "pack_1", seedIds: ["seed_p1"], buyQuantity: 2 });

			const openOp = makeOp(ACTION_PACK_OPEN, {
				packId: "pack_1",
				quantity: 2,
			}, "bob");
			(openOp as any).txId = "tx_open_1";
			await handlePackOpen(openOp, sql);

			const instances = await sql`
				SELECT * FROM nfts WHERE seed_id = 'seed_p1' ORDER BY instance_number
			`;
			expect(instances.length).toBe(2);
			expect(instances[0]!.owner).toBe("bob");
			expect(instances[0]!.instance_number).toBe(1);
			expect(instances[1]!.instance_number).toBe(2);
		});

		test("pack-opened instances have non-null deterministic DNA", async () => {
			await seedCollection();
			await seedForPack("seed_pdna");

			await setupPack({ packId: "pack_dna", seedIds: ["seed_pdna"], buyQuantity: 2 });

			const openOp = makeOp(ACTION_PACK_OPEN, {
				packId: "pack_dna",
				quantity: 2,
			}, "bob");
			(openOp as any).txId = "tx_dna_check";
			await handlePackOpen(openOp, sql);

			const instances = await sql`
				SELECT origin_dna, instance_dna, unique_access_key
				FROM nfts WHERE seed_id = 'seed_pdna' ORDER BY instance_number
			`;
			expect(instances.length).toBe(2);
			for (const inst of instances) {
				expect(inst.origin_dna).toBeTruthy();
				expect(inst.instance_dna).toBeTruthy();
				expect(inst.unique_access_key).toBeTruthy();
			}
			expect(instances[0]!.instance_dna).not.toBe(instances[1]!.instance_dna);
		});

		test("pack open is idempotent on replay", async () => {
			await seedCollection();
			await seedForPack("seed_p2");

			await setupPack({ packId: "pack_2", seedIds: ["seed_p2"], buyQuantity: 3 });

			const openOp = makeOp(ACTION_PACK_OPEN, {
				packId: "pack_2",
				quantity: 1,
			}, "bob");
			(openOp as any).txId = "tx_open_2";
			await handlePackOpen(openOp, sql);

			// Restore balance for replay (simulates re-indexing from scratch)
			await sql`
				UPDATE user_pack_balances
				SET balance = balance + 1
				WHERE account = 'bob' AND pack_id = 'pack_2'
			`;
			await sql`
				UPDATE packs SET total_opened = total_opened - 1
				WHERE id = 'pack_2'
			`;

			// Replay same op
			await handlePackOpen(openOp, sql);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_p2'`;
			expect(instances.length).toBe(1); // not 2

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p2'`;
			expect(seed!.distributed).toBe(1);
		});

		test("two different pack opens from same seed produce sequential instances", async () => {
			await seedCollection();
			await seedForPack("seed_p3");

			await setupPack({ packId: "pack_3", seedIds: ["seed_p3"], buyQuantity: 4 });

			const op1 = makeOp(ACTION_PACK_OPEN, { packId: "pack_3", quantity: 2 }, "bob");
			(op1 as any).txId = "tx_open_3a";
			await handlePackOpen(op1, sql);

			const op2 = makeOp(ACTION_PACK_OPEN, { packId: "pack_3", quantity: 2 }, "bob");
			(op2 as any).txId = "tx_open_3b";
			await handlePackOpen(op2, sql);

			const instances = await sql`
				SELECT instance_number FROM nfts
				WHERE seed_id = 'seed_p3'
				ORDER BY instance_number
			`;
			expect(instances.length).toBe(4);
			expect(instances.map(i => i.instance_number)).toEqual([1, 2, 3, 4]);

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p3'`;
			expect(seed!.distributed).toBe(4);
		});

		test("concurrent pack opens + replays keep distributed accurate", async () => {
			await seedCollection();
			await seedForPack("seed_p4");

			await setupPack({ packId: "pack_4", seedIds: ["seed_p4"], buyQuantity: 10 });

			// 3 different pack opens
			const ops = Array.from({ length: 3 }, (_, i) => {
				const op = makeOp(ACTION_PACK_OPEN, { packId: "pack_4", quantity: 1 }, "bob");
				(op as any).txId = `tx_open_4_${i}`;
				return op;
			});

			for (const op of ops) await handlePackOpen(op, sql);

			// Replay all 3 — restore balances to simulate re-index
			await sql`
				UPDATE user_pack_balances
				SET balance = balance + 3
				WHERE account = 'bob' AND pack_id = 'pack_4'
			`;
			await sql`
				UPDATE packs SET total_opened = total_opened - 3
				WHERE id = 'pack_4'
			`;

			for (const op of ops) await handlePackOpen(op, sql);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_p4'`;
			expect(instances.length).toBe(3); // not 6

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p4'`;
			expect(seed!.distributed).toBe(3);
		});

		test("pack open respects seed max supply across multiple opens", async () => {
			await seedCollection();
			await seedForPack("seed_p5", 3); // max 3 replicas

			const dropTable = [{ seedId: "seed_p5", weight: 1 }];
			const createOp = makeOp(ACTION_PACK_CREATE, {
				id: "pack_5",
				collectionId: COL_ID,
				name: "Pack 5",
				dropTable,
				itemsPerPack: 1,
				maxSupply: 3,
			});
			await handlePackCreate(createOp, sql);
			await sql`
				INSERT INTO user_pack_balances (account, pack_id, balance)
				VALUES ('bob', 'pack_5', 10)
			`;

			// Open 3 packs — should mint 3 instances (hitting cap)
			const op1 = makeOp(ACTION_PACK_OPEN, { packId: "pack_5", quantity: 3 }, "bob");
			(op1 as any).txId = "tx_open_5a";
			await handlePackOpen(op1, sql);

			const [seedAfter3] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p5'`;
			expect(seedAfter3!.distributed).toBe(3);

			// Snapshot state before the failed open
			const [balanceBefore] = await sql`
				SELECT balance FROM user_pack_balances
				WHERE account = 'bob' AND pack_id = 'pack_5'
			`;
			const [packBefore] = await sql`SELECT total_opened FROM packs WHERE id = 'pack_5'`;

			// Open 1 more — seed exhausted, must throw (no silent loss)
			const op2 = makeOp(ACTION_PACK_OPEN, { packId: "pack_5", quantity: 1 }, "bob");
			(op2 as any).txId = "tx_open_5b";
			await expect(handlePackOpen(op2, sql)).rejects.toThrow("all seeds exhausted");

			// Verify ALL five invariants after failed open:
			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_p5'`;
			expect(instances.length).toBe(3); // no new instances

			const [seedFinal] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p5'`;
			expect(seedFinal!.distributed).toBe(3); // distributed unchanged

			const [balanceAfter] = await sql`
				SELECT balance FROM user_pack_balances
				WHERE account = 'bob' AND pack_id = 'pack_5'
			`;
			expect(Number(balanceAfter!.balance)).toBe(Number(balanceBefore!.balance)); // balance not deducted

			const [packAfter] = await sql`SELECT total_opened FROM packs WHERE id = 'pack_5'`;
			expect(Number(packAfter!.total_opened)).toBe(Number(packBefore!.total_opened)); // total_opened unchanged
		});

		test("partial delivery: delivers only packs whose seeds have supply", async () => {
			await seedCollection();
			await seedForPack("seed_partial", 2); // max 2 instances

			const dropTable = [{ seedId: "seed_partial", weight: 1 }];
			const createOp = makeOp(ACTION_PACK_CREATE, {
				id: "pack_partial",
				collectionId: COL_ID,
				name: "Partial Pack",
				dropTable,
				itemsPerPack: 1,
				maxSupply: 2, // matches seed capacity
			});
			await handlePackCreate(createOp, sql);
			// Give more balance than seed can fulfill (simulate oversold scenario)
			await sql`
				INSERT INTO user_pack_balances (account, pack_id, balance)
				VALUES ('bob', 'pack_partial', 5)
			`;

			// Open 1 pack — delivers fine, 1 instance minted
			const op1 = makeOp(ACTION_PACK_OPEN, { packId: "pack_partial", quantity: 1 }, "bob");
			(op1 as any).txId = "tx_partial_1a";
			await handlePackOpen(op1, sql);

			// Open 3 more — only 1 more instance can be produced
			const op2 = makeOp(ACTION_PACK_OPEN, { packId: "pack_partial", quantity: 3 }, "bob");
			(op2 as any).txId = "tx_partial_1b";
			await handlePackOpen(op2, sql);

			// Only 2 total instances minted (seed cap)
			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_partial'`;
			expect(instances.length).toBe(2);

			// Balance deducted for 1 + 1 = 2 delivered packs (not 1 + 3 = 4)
			const [balance] = await sql`
				SELECT balance FROM user_pack_balances
				WHERE account = 'bob' AND pack_id = 'pack_partial'
			`;
			expect(Number(balance!.balance)).toBe(3); // 5 - 2 = 3

			// total_opened reflects only delivered packs
			const [pack] = await sql`SELECT total_opened FROM packs WHERE id = 'pack_partial'`;
			expect(Number(pack!.total_opened)).toBe(2);

			// distributed matches instances
			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_partial'`;
			expect(seed!.distributed).toBe(2);
		});

		test("multiple users opening packs simultaneously from same seed", async () => {
			await seedCollection();
			await seedForPack("seed_p6");

			// Create pack and give packs to two users
			await setupPack({ packId: "pack_6", seedIds: ["seed_p6"], buyQuantity: 3, buyer: "bob" });

			// Also give packs to charlie
			await sql`
				INSERT INTO user_pack_balances (account, pack_id, balance)
				VALUES ('charlie', 'pack_6', 3)
			`;

			// Bob opens 2 packs
			const op1 = makeOp(ACTION_PACK_OPEN, { packId: "pack_6", quantity: 2 }, "bob");
			(op1 as any).txId = "tx_open_6_bob";
			await handlePackOpen(op1, sql);

			// Charlie opens 2 packs from same seed
			const op2 = makeOp(ACTION_PACK_OPEN, { packId: "pack_6", quantity: 2 }, "charlie");
			(op2 as any).txId = "tx_open_6_charlie";
			await handlePackOpen(op2, sql);

			const instances = await sql`
				SELECT instance_number, owner FROM nfts
				WHERE seed_id = 'seed_p6'
				ORDER BY instance_number
			`;
			expect(instances.length).toBe(4);
			// Instance numbers should be sequential regardless of who opened
			expect(instances.map(i => i.instance_number)).toEqual([1, 2, 3, 4]);
			// First 2 belong to bob, last 2 to charlie
			expect(instances[0]!.owner).toBe("bob");
			expect(instances[1]!.owner).toBe("bob");
			expect(instances[2]!.owner).toBe("charlie");
			expect(instances[3]!.owner).toBe("charlie");

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p6'`;
			expect(seed!.distributed).toBe(4);
		});

		test("rejects pack open with 0 quantity", async () => {
			await seedCollection();
			await seedForPack("seed_p0");
			await setupPack({ packId: "pack_0q", seedIds: ["seed_p0"], buyQuantity: 5 });

			const op = makeOp(ACTION_PACK_OPEN, { packId: "pack_0q", quantity: 0 }, "bob");
			await expect(handlePackOpen(op, sql)).rejects.toThrow("positive");
		});

		test("rejects pack open with insufficient balance", async () => {
			await seedCollection();
			await seedForPack("seed_pinsuf");
			await setupPack({ packId: "pack_insuf", seedIds: ["seed_pinsuf"], buyQuantity: 1 });

			const op = makeOp(ACTION_PACK_OPEN, { packId: "pack_insuf", quantity: 5 }, "bob");
			(op as any).txId = "tx_insuf";
			await expect(handlePackOpen(op, sql)).rejects.toThrow("Insufficient");
		});

		test("rejects pack open for non-existent pack", async () => {
			const op = makeOp(ACTION_PACK_OPEN, { packId: "pack_ghost", quantity: 1 }, "bob");
			await expect(handlePackOpen(op, sql)).rejects.toThrow("not found");
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
			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop",
				instanceId: instId,
				approved: true,
			}), sql);

			// Alice lista el NFT en el marketplace built-in
			const listData = await makeListData({ nftId: instId, priceAmount: "50.000" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			// gameshop intenta mover el NFT → bloqueado
			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice",
					to: "buyer1",
					instanceId: instId,
				}, "gameshop"), sql),
			).rejects.toThrow("listed for sale");
		});

		// After unlist, approved spender can transfer
		test("transferFrom succeeds after unlist", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop",
				instanceId: instId,
				approved: true,
			}), sql);

			const listData2 = await makeListData({ nftId: instId, priceAmount: "50.000" });
			await handleList(makeOp(ACTION_LIST, listData2), sql);

			// Alice quita el listado
			await handleUnlist(makeOp(ACTION_UNLIST, { nftId: instId }), sql);

			// Ahora gameshop puede mover el NFT
			await handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice",
				to: "buyer1",
				instanceId: instId,
			}, "gameshop"), sql);

			const [nft] = await sql`SELECT owner, status FROM nfts WHERE id = ${instId}`;
			expect(nft!.owner).toBe("buyer1");
			expect(nft!.status).toBe("active");
		});

		// Escenario A con approve_all: mismo guard aplica
		test("transferFrom via approve_all blocked while listed", async () => {
			await seedCollection();
			await seedMint();

			// Approve "marketbot" for the entire collection
			await handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "marketbot",
				collectionId: COL_ID,
				approved: true,
			}), sql);

			const listData3 = await makeListData({ nftId: "seed_test1", priceAmount: "100.000" });
			await handleList(makeOp(ACTION_LIST, listData3), sql);

			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice",
					to: "buyer2",
					instanceId: "seed_test1",
				}, "marketbot"), sql),
			).rejects.toThrow("listed for sale");
		});

		// Escenario C: tercero puro (sin marketplace built-in)
		test("approve → transferFrom works on active NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			// Alice aprueba a marketbot
			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "marketbot",
				instanceId: instId,
				approved: true,
			}), sql);

			// marketbot transfiere a buyer (pago HIVE fuera del indexador)
			await handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice",
				to: "buyer3",
				instanceId: instId,
			}, "marketbot"), sql);

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
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "buyer1", instanceId: instId,
				}, "stranger"), sql),
			).rejects.toThrow();
		});

		test("transferFrom rejected with wrong from", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);

			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "eve", to: "buyer1", instanceId: instId,
				}, "gameshop"), sql),
			).rejects.toThrow("not owner");
		});

		test("transferFrom rejected for self-transfer (from === to)", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);

			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "alice", instanceId: instId,
				}, "gameshop"), sql),
			).rejects.toThrow();
		});

		test("transferFrom rejected for burned NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);
			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), sql);

			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "buyer1", instanceId: instId,
				}, "gameshop"), sql),
			).rejects.toThrow("burned");
		});

		test("transferFrom rejected for lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);
			await handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), sql);

			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice", to: "buyer1", instanceId: instId,
				}, "gameshop"), sql),
			).rejects.toThrow("lent");
		});

	});

	// ─── marketplace fees & royalties ──────────────────────────

	describe("marketplace fees & royalties", () => {
		test("list with marketplace stores it in DB", async () => {
			await seedCollection();
			await seedMint();

			const listData = await makeListData({ nftId: "seed_test1", marketplace: "norse" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const [nft] = await sql`SELECT listing_marketplace, listing_price, status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.listing_marketplace).toBe("norse");
			expect(nft!.status).toBe("listed");
		});

		test("list without marketplace stores null", async () => {
			await seedCollection();
			await seedMint();

			const listData = await makeListData({ nftId: "seed_test1" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const [nft] = await sql`SELECT listing_marketplace FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.listing_marketplace).toBeNull();
		});
	});

	// ─── signer validation (congruence fixes) ──────────────────

	describe("signer validation", () => {
		test("create_collection ignores creator field and uses signer", async () => {
			const { id: colId, data: colData } = await makeCanonicalCollection(
				"alice", "Spoofed", "SPOOF",
			);
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				...colData,
				creator: "bob",
			}, "alice");
			await handleCreateCollection(op, sql);

			const [row] = await sql`SELECT creator FROM collections WHERE id = ${colId}`;
			expect(row).toBeDefined();
			expect(row!.creator).toBe("alice");
		});

		test("mint rejects non-creator signer", async () => {
			await seedCollection();
			const op = makeOp(ACTION_MINT, {
				id: "seed_evil",
				collectionId: COL_ID,
				metadata: { name: "Evil" },
			}, "eve");
			await expect(handleMint(op, sql)).rejects.toThrow("Only the collection creator can mint");
		});

		test("replicate computes DNA from original, ignoring user-supplied values", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_REPLICATE, {
				id: "replica_dna_test",
				originalId: "seed_test1",
				newOwner: "bob",
				originDna: "FAKE_ORIGIN",
				instanceDna: "FAKE_INSTANCE",
				uniqueAccessKey: "FAKEKEY9",
			});
			await handleReplicate(op, sql);

			const [replica] = await sql`SELECT origin_dna, instance_dna, unique_access_key FROM nfts WHERE id = 'replica_dna_test'`;
			expect(replica).toBeDefined();
			expect(replica!.origin_dna).not.toBe("FAKE_ORIGIN");
			expect(replica!.instance_dna).not.toBe("FAKE_INSTANCE");
			expect(replica!.unique_access_key).not.toBe("FAKEKEY9");
			// DNA should be derived from original
			expect(replica!.instance_dna).toBeTruthy();
			expect(replica!.unique_access_key).toBeTruthy();
		});

		test("replicate rejects non-owner signer", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_REPLICATE, {
				id: "replica_evil",
				originalId: "seed_test1",
				newOwner: "eve",
			}, "eve");
			await expect(handleReplicate(op, sql)).rejects.toThrow("not owner");
		});

		test("replicate rejects listed original", async () => {
			await seedCollection();
			await seedMint();
			const listData = await makeListData({ nftId: "seed_test1", priceAmount: "5.000" });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const op = makeOp(ACTION_REPLICATE, {
				id: "replica_listed",
				originalId: "seed_test1",
				newOwner: "bob",
			});
			await expect(handleReplicate(op, sql)).rejects.toThrow("listed");
		});

		test("self-transfer rejected", async () => {
			await seedCollection();
			await seedMint();
			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "alice" }), sql),
			).rejects.toThrow();
		});

		test("self-approval rejected (nft_approve)", async () => {
			await seedCollection();
			await seedMint();
			await expect(
				handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
					spender: "alice",
					instanceId: "seed_test1",
					approved: true,
				}), sql),
			).rejects.toThrow();
		});

		test("self-approval rejected (nft_approve_all)", async () => {
			await seedCollection();
			await expect(
				handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
					spender: "alice",
					collectionId: COL_ID,
					approved: true,
				}), sql),
			).rejects.toThrow();
		});

		test("pack_approve rejects signer without pack balance", async () => {
			await seedCollection();
			await seedMint();

			const packOp = makeOp(ACTION_PACK_CREATE, {
				id: "pack_test",
				collectionId: COL_ID,
				name: "Test Pack",
				dropTable: [{ seedId: "seed_test1", weight: 1 }],
				itemsPerPack: 1,
				maxSupply: 5,
			});
			await handlePackCreate(packOp, sql);

			const approveOp = makeOp(ACTION_PACK_APPROVE, {
				spender: "bob",
				packId: "pack_test",
				approved: true,
				quantity: 5,
			}, "eve");
			await expect(handlePackApprove(approveOp, sql)).rejects.toThrow("no balance");
		});
	});

	// ─── buy handler guards ───────────────────────────

	describe("buy guards", () => {
		const nodeAccount = config.hiveAccount;

		async function listNft(nftId: string, priceAmount = "10.000") {
			const listData = await makeListData({ nftId, priceAmount });
			await handleList(makeOp(ACTION_LIST, listData), sql);
			const [nft] = await sql`SELECT listing_id, listing_tx_id, tx_id FROM nfts WHERE id = ${nftId}`;
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
			const { listingId, listTxId, txId } = await listNft("seed_test1");

			// alice owns the NFT, alice tries to buy — paired transfer from alice
			const split = calculatePaymentSplit(10, "HIVE", 0, null, "alice", nodeAccount);
			const transfers = [
				{ from: "alice", to: "alice", amount: split.sellerAmount, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}seed_test1` },
				{ from: "alice", to: nodeAccount, amount: split.feeAmount, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}seed_test1` },
			];
			const buyOp = makeOp(ACTION_BUY, {
				nftId: "seed_test1", listingId, listTxId, txId,
			}, nodeAccount, transfers);

			await expect(handleBuy(buyOp, sql)).rejects.toThrow("Cannot buy own");
		});

		test("rejects buy unlisted NFT", async () => {
			await seedCollection();
			await seedMint();

			const buyOp = makeBuyOp("seed_test1", "list_fake", "tx_fake", "bob", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("not listed");
		});

		test("rejects buy non-existent NFT", async () => {
			const buyOp = makeBuyOp("nft_ghost", "list_fake", "tx_fake", "bob", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("not found");
		});

		test("rejects buy burned NFT", async () => {
			await seedCollection();
			await seedMint();
			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "null" }), sql);

			const buyOp = makeBuyOp("seed_test1", "list_fake", "tx_fake", "bob", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("burned");
		});

		test("rejects buy lent NFT", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();
			await handleNftLend(makeOp(ACTION_NFT_LEND, { instanceId: instId, borrower: "bob" }), sql);

			const buyOp = makeBuyOp(instId, "list_fake", "tx_fake", "charlie", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("lent");
		});

		test("rejects buy with expired listing", async () => {
			await seedCollection();
			await seedMint();

			// Force-list with past expiry via SQL
			await sql`
				UPDATE nfts
				SET status = 'listed', listing_id = 'list_expired', listing_tx_id = 'tx_exp',
					listing_price = 10, listing_currency = 'HIVE',
					listing_expires_at = ${new Date("2023-01-01").toISOString()}
				WHERE id = 'seed_test1'
			`;

			const buyOp = makeBuyOp("seed_test1", "list_expired", "tx_exp", "bob", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("expired");
		});

		test("rejects buy with listingId mismatch", async () => {
			await seedCollection();
			await seedMint();
			const { listTxId } = await listNft("seed_test1");

			const buyOp = makeBuyOp("seed_test1", "list_wrong_id", listTxId, "bob", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("listingId mismatch");
		});

		test("rejects buy with listTxId mismatch", async () => {
			await seedCollection();
			await seedMint();
			const { listingId } = await listNft("seed_test1");

			const buyOp = makeBuyOp("seed_test1", listingId, "tx_wrong", "bob", "alice");
			await expect(handleBuy(buyOp, sql)).rejects.toThrow("listTxId mismatch");
		});

		test("rejects buy with wrong payment amount", async () => {
			await seedCollection();
			await seedMint();
			const { listingId, listTxId, txId } = await listNft("seed_test1");

			// Send wrong amount (50 instead of 9.9 to seller)
			const transfers = [
				{ from: "bob", to: "alice", amount: 50, currency: "HIVE", memo: `${MEMO_PREFIX_BUY}seed_test1` },
				{ from: "bob", to: nodeAccount, amount: 0.1, currency: "HIVE", memo: `${MEMO_PREFIX_FEE}seed_test1` },
			];
			const buyOp = makeOp(ACTION_BUY, {
				nftId: "seed_test1", listingId, listTxId, txId,
			}, nodeAccount, transfers);

			await expect(handleBuy(buyOp, sql)).rejects.toThrow("Missing");
		});
	});

	// ─── approval lifecycle ───────────────────────────

	describe("approval lifecycle", () => {
		test("transfer clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);

			const [before] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(before).toBeDefined();

			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "bob" }), sql);

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("burn clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);

			await handleTransfer(makeOp(ACTION_TRANSFER, { nftId: instId, to: "null" }), sql);

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("buy clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);

			// List and buy
			const listData = await makeListData({ nftId: instId });
			await handleList(makeOp(ACTION_LIST, listData), sql);

			const [nft] = await sql`SELECT listing_id, listing_tx_id, tx_id FROM nfts WHERE id = ${instId}`;
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
			await handleBuy(buyOp, sql);

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("lend clears nft_allowances", async () => {
			await seedCollection();
			await seedMint();
			const instId = await seedInstance();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop", instanceId: instId, approved: true,
			}), sql);

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: instId, borrower: "bob",
			}), sql);

			const [after] = await sql`SELECT * FROM nft_allowances WHERE nft_id = ${instId}`;
			expect(after).toBeUndefined();
		});

		test("collection_allowances persist after nft_transfer_from", async () => {
			await seedCollection();
			await seedMint();

			// Approve gameshop for entire collection
			await handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "gameshop", collectionId: COL_ID, approved: true,
			}), sql);

			// gameshop transfers alice's NFT to bob
			await handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice", to: "bob", instanceId: "seed_test1",
			}, "gameshop"), sql);

			// Collection-level allowance must still exist
			const [allowance] = await sql`
				SELECT * FROM collection_allowances
				WHERE collection_id = ${COL_ID} AND owner = 'alice' AND spender = 'gameshop'
			`;
			expect(allowance).toBeDefined();
		});
	});

});

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, type Queryable } from "@/db/client.ts";
import type { ParsedOperation, AuthLevel } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleBulkDistribute } from "@/processor/handlers/core/bulk-distribute.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleBurn } from "@/processor/handlers/core/burn.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleUnlist } from "@/processor/handlers/marketplace/unlist.ts";
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
import {
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_BULK_DISTRIBUTE,
	ACTION_TRANSFER,
	ACTION_BURN,
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
} from "nftlox-sdk";

function makeOp(
	action: string,
	data: Record<string, unknown>,
	signer = "alice",
	pairedTransfers?: ParsedOperation["pairedTransfers"],
	authLevel: AuthLevel = "posting",
): ParsedOperation {
	return {
		blockNum: 90000100,
		timestamp: "2024-01-01T00:00:00",
		txId: `tx_${action}_${Date.now()}`,
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
	await sql`DELETE FROM collections`;
}

async function seedCollection(txn: Queryable = sql) {
	const op = makeOp(ACTION_CREATE_COLLECTION, {
		id: "col_test",
		name: "Test Collection",
		symbol: "TEST",
		creator: "alice",
		totalPotential: 1000,
		originDna: "dna_col_test_1234",
		metadata: { description: "A test collection", image: "https://example.com/img.png" },
		rules: { transferable: true, burnable: true, replicable: true, royaltyPct: 5 },
	});
	await handleCreateCollection(op, txn);
}

async function seedMint(txn: Queryable = sql) {
	const op = makeOp(ACTION_MINT, {
		id: "seed_test1",
		collectionId: "col_test",
		edition: 1,
		owner: "alice",
		originDna: "dna_col_test_1234",
		instanceDna: "dna_inst_12345",
		uniqueAccessKey: "key12345",
		maxReplicas: 10,
		metadata: { name: "Test Seed", imageUrl: "https://example.com/nft.png", imageHash: "img_abc" },
	});
	await handleMint(op, txn);
}

describe("Handlers (integration)", () => {
	beforeAll(async () => {
		// Drop all tables to ensure clean schema (testnet only)
		await sql.unsafe(`
			DROP TABLE IF EXISTS nft_loans, nft_allowances, collection_allowances,
				pack_allowances, user_pack_balances, data_operators,
				orphaned_buys, invalid_operations, owner_nft_counts,
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
			const [row] = await sql`SELECT * FROM collections WHERE id = 'col_test'`;
			expect(row).toBeDefined();
			expect(row!.name).toBe("Test Collection");
			expect(row!.symbol).toBe("TEST");
			expect(row!.creator).toBe("alice");
		});

		test("rejects duplicate collection", async () => {
			await seedCollection();
			await expect(seedCollection()).rejects.toThrow("already exists");
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

		test("rejects duplicate mint", async () => {
			await seedCollection();
			await seedMint();
			await expect(seedMint()).rejects.toThrow("already exists");
		});

		test("detects seed vs instance by ID prefix", async () => {
			await seedCollection();

			const seedOp = makeOp(ACTION_MINT, {
				id: "seed_aaa",
				collectionId: "col_test",
				metadata: { name: "Seed" },
			});
			await handleMint(seedOp, sql);

			const instOp = makeOp(ACTION_MINT, {
				id: "nft_bbb_1_ccc",
				collectionId: "col_test",
				metadata: { name: "Instance" },
			});
			await handleMint(instOp, sql);

			const [seed] = await sql`SELECT nft_type FROM nfts WHERE id = 'seed_aaa'`;
			const [inst] = await sql`SELECT nft_type FROM nfts WHERE id = 'nft_bbb_1_ccc'`;
			expect(seed!.nft_type).toBe("seed");
			expect(inst!.nft_type).toBe("instance");
		});
	});

	// ─── bulk_distribute ────────────────────────────

	describe("bulk_distribute", () => {
		test("distributes instances from seed", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_test1", quantity: 3 }],
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

		test("rejects distribute by non-owner and non-creator", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_test1", quantity: 1 }],
			}, "eve");
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("not owner");
		});

		test("rejects distribute over max supply", async () => {
			await seedCollection();

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_limited",
				collectionId: "col_test",
				maxReplicas: 2,
				metadata: { name: "Limited" },
			});
			await handleMint(mintOp, sql);

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_limited", quantity: 3 }],
			});
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("insufficient supply");
		});

		test("rejects duplicate seedId in items", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [
					{ seedId: "seed_test1", quantity: 1 },
					{ seedId: "seed_test1", quantity: 1 },
				],
			});
			await expect(handleBulkDistribute(op, sql)).rejects.toThrow("Duplicate seedId");
		});

		test("idempotent on reprocess (same tx)", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_test1", quantity: 2 }],
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
				items: [{ seedId: "seed_test1", quantity: 1 }],
			});
			await handleBulkDistribute(op, sql);

			const [inst] = await sql`SELECT owner FROM nfts WHERE seed_id = 'seed_test1'`;
			expect(inst!.owner).toBe("alice");
		});

		test("collection creator can distribute", async () => {
			await seedCollection(); // creator = alice

			// Mint seed owned by bob (alice is creator, mints for bob)
			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_bob",
				collectionId: "col_test",
				owner: "bob",
				maxReplicas: 10,
				metadata: { name: "Bob Seed" },
			}, "alice");
			await handleMint(mintOp, sql);

			// Alice (creator) distributes bob's seed
			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [{ seedId: "seed_bob", quantity: 2 }],
			}, "alice");
			await handleBulkDistribute(op, sql);

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
				items: [{ seedId: "seed_test1", quantity: 2 }],
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
				items: [{ seedId: "seed_test1", quantity: 2 }],
			});
			await handleBulkDistribute(op1, sql);

			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "charlie",
				items: [{ seedId: "seed_test1", quantity: 3 }],
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
				items: [{ seedId: "seed_test1", quantity: 3 }],
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
				collectionId: "col_test",
				maxReplicas: 3,
				metadata: { name: "Capped" },
			});
			await handleMint(mintOp, sql);

			// Distribute 2
			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_capped", quantity: 2 }],
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
				collectionId: "col_test",
				maxReplicas: 10,
				metadata: { name: "Seed 2" },
			});
			await handleMint(mintOp2, sql);

			const op = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [
					{ seedId: "seed_test1", quantity: 2 },
					{ seedId: "seed_test2", quantity: 3 },
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
				collectionId: "col_test",
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
					items: [{ seedId: "seed_concurrent", quantity: 2 }],
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
				collectionId: "col_test",
				maxReplicas: 5,
				metadata: { name: "Race Seed" },
			});
			await handleMint(mintOp, sql);

			// Distribute 3 first
			const op1 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "alice",
				items: [{ seedId: "seed_race", quantity: 3 }],
			});
			(op1 as any).txId = "tx_race_1";
			await handleBulkDistribute(op1, sql);

			// Now try to distribute 3 more — should fail (only 2 remaining)
			const op2 = makeOp(ACTION_BULK_DISTRIBUTE, {
				to: "bob",
				items: [{ seedId: "seed_race", quantity: 3 }],
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
				collectionId: "col_test",
				maxReplicas: 10,
				metadata: { name: "Replay Multi" },
			});
			await handleMint(mintOp, sql);

			const replayUsers = ["user-aaa", "user-bbb", "user-ccc"];
			const ops = Array.from({ length: 3 }, (_, t) => {
				const op = makeOp(ACTION_BULK_DISTRIBUTE, {
					to: replayUsers[t],
					items: [{ seedId: "seed_replay_multi", quantity: 2 }],
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
			await handleBurn(makeOp(ACTION_BURN, { nftId: "seed_test1" }), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("burned");
		});

		test("rejects transfer of listed NFT", async () => {
			await seedCollection();
			await seedMint();
			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "10.000", currency: "HIVE" },
			}), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("listed for sale");
		});

		test("allows transfer of NFT with expired listing", async () => {
			await seedCollection();
			await seedMint();
			// Set listing that expires before the block timestamp used in makeOp
			const blockTime = new Date("2024-01-01T00:00:00").getTime();
			const pastExpiry = blockTime - 60_000;
			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "10.000", currency: "HIVE" },
				expiresAt: pastExpiry,
			}), sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_test1", to: "bob" });
			await handleTransfer(op, sql);

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("bob");
		});

		test("rejects transfer from non-transferable collection", async () => {
			// Create non-transferable collection
			const colOp = makeOp(ACTION_CREATE_COLLECTION, {
				id: "col_locked",
				name: "Locked Collection",
				symbol: "LOCK",
				creator: "alice",
				totalPotential: 100,
				originDna: "dna_col_locked",
				metadata: { description: "Non-transferable" },
				rules: { transferable: false, burnable: true, replicable: true, royaltyPct: 0 },
			});
			await handleCreateCollection(colOp, sql);

			const mintOp = makeOp(ACTION_MINT, {
				id: "seed_locked1",
				collectionId: "col_locked",
				metadata: { name: "Locked Seed" },
			});
			await handleMint(mintOp, sql);

			const op = makeOp(ACTION_TRANSFER, { nftId: "seed_locked1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("not transferable");
		});
	});

	// ─── burn ───────────────────────────────────────

	describe("burn", () => {
		test("burns NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleBurn(makeOp(ACTION_BURN, { nftId: "seed_test1" }), sql);

			const [nft] = await sql`SELECT status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.status).toBe("burned");
		});

		test("rejects double burn", async () => {
			await seedCollection();
			await seedMint();
			await handleBurn(makeOp(ACTION_BURN, { nftId: "seed_test1" }), sql);
			await expect(
				handleBurn(makeOp(ACTION_BURN, { nftId: "seed_test1" }), sql),
			).rejects.toThrow("NFT is burned");
		});
	});

	// ─── list / unlist / buy ────────────────────────

	describe("marketplace", () => {
		test("list → unlist cycle", async () => {
			await seedCollection();
			await seedMint();

			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "10.000", currency: "HIVE" },
			}), sql);

			const [listed] = await sql`SELECT status, listing_price, listing_currency FROM nfts WHERE id = 'seed_test1'`;
			expect(listed!.status).toBe("listed");
			expect(Number(listed!.listing_price)).toBe(10);
			expect(listed!.listing_currency).toBe("HIVE");

			await handleUnlist(makeOp(ACTION_UNLIST, { nftId: "seed_test1" }), sql);

			const [unlisted] = await sql`SELECT status, listing_price FROM nfts WHERE id = 'seed_test1'`;
			expect(unlisted!.status).toBe("active");
			expect(unlisted!.listing_price).toBeNull();
		});

	});

	// ─── lending ────────────────────────────────────

	describe("nft_lend / nft_return", () => {
		test("lend sets status to lent", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			const [nft] = await sql`SELECT status, owner FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.status).toBe("lent");
			expect(nft!.owner).toBe("alice"); // owner unchanged
		});

		test("lend creates loan record", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			const [loan] = await sql`SELECT * FROM nft_loans WHERE nft_id = 'seed_test1'`;
			expect(loan).toBeDefined();
			expect(loan!.lender).toBe("alice");
			expect(loan!.borrower).toBe("bob");
		});

		test("return restores active status", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await handleNftReturn(makeOp(ACTION_NFT_RETURN, {
				instanceId: "seed_test1",
			}), sql); // alice (lender) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.status).toBe("active");

			const [loan] = await sql`SELECT * FROM nft_loans WHERE nft_id = 'seed_test1'`;
			expect(loan).toBeUndefined();
		});

		test("borrower can return", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await handleNftReturn(makeOp(ACTION_NFT_RETURN, {
				instanceId: "seed_test1",
			}, "bob"), sql); // bob (borrower) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = 'seed_test1'`;
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

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: "seed_test1",
					borrower: "charlie",
				}, "eve"), sql),
			).rejects.toThrow("not owner");
		});

		test("rejects double lend", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleNftLend(makeOp(ACTION_NFT_LEND, {
					instanceId: "seed_test1",
					borrower: "charlie",
				}), sql),
			).rejects.toThrow("must be active");
		});

		test("rejects return by stranger", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleNftReturn(makeOp(ACTION_NFT_RETURN, {
					instanceId: "seed_test1",
				}, "eve"), sql),
			).rejects.toThrow("neither lender nor borrower");
		});

		// ─── lent guards ────────────────────────────

		test("rejects transfer of lent NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleTransfer(makeOp(ACTION_TRANSFER, {
					nftId: "seed_test1",
					to: "charlie",
				}), sql),
			).rejects.toThrow("lent");
		});

		test("rejects burn of lent NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleBurn(makeOp(ACTION_BURN, { nftId: "seed_test1" }), sql),
			).rejects.toThrow("lent");
		});

		test("rejects list of lent NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp(ACTION_NFT_LEND, {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleList(makeOp(ACTION_LIST, {
					nftId: "seed_test1",
					price: { amount: "10.000", currency: "HIVE" },
				}), sql),
			).rejects.toThrow("lent");
		});
	});

	// ─── pack_open (distributed control) ───────────

	describe("pack_open", () => {
		// Helper: create a seed with unlimited supply for pack testing
		async function seedForPack(id: string, maxReplicas = 0) {
			const op = makeOp(ACTION_MINT, {
				id,
				collectionId: "col_test",
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
			buyQuantity: number;
			buyer?: string;
		}) {
			const dropTable = opts.seedIds.map(seedId => ({ seedId, weight: 1 }));
			const createOp = makeOp(ACTION_PACK_CREATE, {
				id: opts.packId,
				collectionId: "col_test",
				name: `Pack ${opts.packId}`,
				dropTable,
				itemsPerPack: opts.itemsPerPack ?? 1,
				maxSupply: 0,
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

			// Create pack with maxSupply matching seed capacity
			const dropTable = [{ seedId: "seed_p5", weight: 1 }];
			const createOp = makeOp(ACTION_PACK_CREATE, {
				id: "pack_5",
				collectionId: "col_test",
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

			// Open 1 more — seed is exhausted, should produce 0 new instances
			const op2 = makeOp(ACTION_PACK_OPEN, { packId: "pack_5", quantity: 1 }, "bob");
			(op2 as any).txId = "tx_open_5b";
			await handlePackOpen(op2, sql);

			const instances = await sql`SELECT * FROM nfts WHERE seed_id = 'seed_p5'`;
			expect(instances.length).toBe(3); // capped

			const [seedFinal] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_p5'`;
			expect(seedFinal!.distributed).toBe(3);
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
	});

	// ─── marketplace + allowances interaction ──────

	describe("marketplace & third-party coexistence", () => {

		// Escenario A: Juego aprobado no puede mover NFT listado
		test("transferFrom blocked while NFT is listed", async () => {
			await seedCollection();
			await seedMint();

			// Alice aprueba a "gameshop" como spender
			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop",
				instanceId: "seed_test1",
				approved: true,
			}), sql);

			// Alice lista el NFT en el marketplace built-in
			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "50.000", currency: "HIVE" },
			}), sql);

			// gameshop intenta mover el NFT → bloqueado
			await expect(
				handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
					from: "alice",
					to: "buyer1",
					instanceId: "seed_test1",
				}, "gameshop"), sql),
			).rejects.toThrow("listed for sale");
		});

		// Escenario A continuación: después de unlist, el juego puede mover
		test("transferFrom succeeds after unlist", async () => {
			await seedCollection();
			await seedMint();

			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "gameshop",
				instanceId: "seed_test1",
				approved: true,
			}), sql);

			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "50.000", currency: "HIVE" },
			}), sql);

			// Alice quita el listado
			await handleUnlist(makeOp(ACTION_UNLIST, { nftId: "seed_test1" }), sql);

			// Ahora gameshop puede mover el NFT
			await handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice",
				to: "buyer1",
				instanceId: "seed_test1",
			}, "gameshop"), sql);

			const [nft] = await sql`SELECT owner, status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("buyer1");
			expect(nft!.status).toBe("active");
		});

		// Escenario A con approve_all: mismo guard aplica
		test("transferFrom via approve_all blocked while listed", async () => {
			await seedCollection();
			await seedMint();

			// Alice aprueba a "marketbot" para toda la colección
			await handleNftApproveAll(makeOp(ACTION_NFT_APPROVE_ALL, {
				spender: "marketbot",
				collectionId: "col_test",
				approved: true,
			}), sql);

			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "100.000", currency: "HIVE" },
			}), sql);

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

			// Alice aprueba a marketbot
			await handleNftApprove(makeOp(ACTION_NFT_APPROVE, {
				spender: "marketbot",
				instanceId: "seed_test1",
				approved: true,
			}), sql);

			// marketbot transfiere a buyer (pago HIVE fuera del indexador)
			await handleNftTransferFrom(makeOp(ACTION_NFT_TRANSFER_FROM, {
				from: "alice",
				to: "buyer3",
				instanceId: "seed_test1",
			}, "marketbot"), sql);

			const [nft] = await sql`SELECT owner, status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("buyer3");
			expect(nft!.status).toBe("active");

			// Allowance limpiada después de transferFrom
			const [allowance] = await sql`SELECT * FROM nft_allowances WHERE nft_id = 'seed_test1'`;
			expect(allowance).toBeUndefined();
		});

	});

	// ─── marketplace fees & royalties ──────────────────────────

	describe("marketplace fees & royalties", () => {
		test("list with marketplace stores it in DB", async () => {
			await seedCollection();
			await seedMint();

			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "10.000", currency: "HIVE" },
				marketplace: "norse",
			}), sql);

			const [nft] = await sql`SELECT listing_marketplace, listing_price, status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.listing_marketplace).toBe("norse");
			expect(nft!.status).toBe("listed");
		});

		test("list without marketplace stores null", async () => {
			await seedCollection();
			await seedMint();

			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "10.000", currency: "HIVE" },
			}), sql);

			const [nft] = await sql`SELECT listing_marketplace FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.listing_marketplace).toBeNull();
		});
	});

	// ─── signer validation (congruence fixes) ──────────────────

	describe("signer validation", () => {
		test("create_collection ignores creator field and uses signer", async () => {
			const op = makeOp(ACTION_CREATE_COLLECTION, {
				id: "col_spoofed",
				name: "Spoofed",
				symbol: "SPOOF",
				creator: "bob",
				metadata: {},
				rules: {},
			}, "alice");
			await handleCreateCollection(op, sql);

			const [row] = await sql`SELECT creator FROM collections WHERE id = 'col_spoofed'`;
			expect(row).toBeDefined();
			expect(row!.creator).toBe("alice");
		});

		test("mint rejects non-creator signer", async () => {
			await seedCollection();
			const op = makeOp(ACTION_MINT, {
				id: "seed_evil",
				collectionId: "col_test",
				metadata: { name: "Evil" },
			}, "eve");
			await expect(handleMint(op, sql)).rejects.toThrow("Only the collection creator can mint");
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
			await handleList(makeOp(ACTION_LIST, {
				nftId: "seed_test1",
				price: { amount: "5.000", currency: "HIVE" },
			}), sql);

			const op = makeOp(ACTION_REPLICATE, {
				id: "replica_listed",
				originalId: "seed_test1",
				newOwner: "bob",
			});
			await expect(handleReplicate(op, sql)).rejects.toThrow("listed");
		});

		test("pack_approve rejects signer without pack balance", async () => {
			await seedCollection();
			await seedMint();

			const packOp = makeOp(ACTION_PACK_CREATE, {
				id: "pack_test",
				collectionId: "col_test",
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

});

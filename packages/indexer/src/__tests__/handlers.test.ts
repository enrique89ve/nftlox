import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql, type Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { handleCreateCollection } from "@/processor/handlers/core/create-collection.ts";
import { handleMint } from "@/processor/handlers/core/mint.ts";
import { handleDistribute } from "@/processor/handlers/core/distribute.ts";
import { handleTransfer } from "@/processor/handlers/core/transfer.ts";
import { handleBurn } from "@/processor/handlers/core/burn.ts";
import { handleList } from "@/processor/handlers/marketplace/list.ts";
import { handleUnlist } from "@/processor/handlers/marketplace/unlist.ts";
import { handleBuy } from "@/processor/handlers/marketplace/buy.ts";
import { handleNftLend } from "@/processor/handlers/lending/nft-lend.ts";
import { handleNftReturn } from "@/processor/handlers/lending/nft-return.ts";

function makeOp(action: string, data: Record<string, unknown>, signer = "alice"): ParsedOperation {
	return {
		blockNum: 90000100,
		timestamp: "2024-01-01T00:00:00",
		txId: `tx_${action}_${Date.now()}`,
		signer,
		action: action as ParsedOperation["action"],
		version: "0.2.1",
		data,
	};
}

async function cleanDb() {
	await sql`DELETE FROM nft_loans`;
	await sql`DELETE FROM data_operators`;
	await sql`DELETE FROM nft_allowances`;
	await sql`DELETE FROM collection_allowances`;
	await sql`DELETE FROM pack_allowances`;
	await sql`DELETE FROM history_events`;
	await sql`DELETE FROM offers`;
	await sql`DELETE FROM nfts`;
	await sql`DELETE FROM collections`;
}

async function seedCollection(txn: Queryable = sql) {
	const op = makeOp("create_collection", {
		id: "col_test",
		name: "Test Collection",
		symbol: "TEST",
		creator: "alice",
		totalPotential: 1000,
		originDna: "dna_col_test_1234",
		metadata: { description: "A test collection", image: "https://example.com/img.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 5 },
	});
	await handleCreateCollection(op, txn);
}

async function seedMint(txn: Queryable = sql) {
	const op = makeOp("mint", {
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
		await sql`SELECT 1`;
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

		test("creates history event", async () => {
			await seedCollection();
			const [event] = await sql`SELECT * FROM history_events WHERE event_type = 'create_collection'`;
			expect(event).toBeDefined();
			expect(event!.from_account).toBe("alice");
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
			const op = makeOp("mint", {
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

			const seedOp = makeOp("mint", {
				id: "seed_aaa",
				collectionId: "col_test",
				metadata: { name: "Seed" },
			});
			await handleMint(seedOp, sql);

			const instOp = makeOp("mint", {
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

	// ─── distribute ─────────────────────────────────

	describe("distribute", () => {
		test("distributes instance from seed", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp("distribute", {
				seedId: "seed_test1",
				instanceId: "nft_test1_1_abc",
				to: "bob",
				instanceNumber: 1,
			});
			await handleDistribute(op, sql);

			const [inst] = await sql`SELECT * FROM nfts WHERE id = 'nft_test1_1_abc'`;
			expect(inst).toBeDefined();
			expect(inst!.owner).toBe("bob");
			expect(inst!.seed_id).toBe("seed_test1");
			expect(inst!.nft_type).toBe("instance");

			const [seed] = await sql`SELECT distributed FROM nfts WHERE id = 'seed_test1'`;
			expect(seed!.distributed).toBe(1);
		});

		test("rejects distribute by non-owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp("distribute", {
				seedId: "seed_test1",
				instanceId: "nft_test1_1_abc",
				to: "bob",
				instanceNumber: 1,
			}, "eve");
			await expect(handleDistribute(op, sql)).rejects.toThrow("not owner");
		});

		test("rejects distribute over max supply", async () => {
			await seedCollection();

			// Mint seed with maxReplicas = 1
			const mintOp = makeOp("mint", {
				id: "seed_limited",
				collectionId: "col_test",
				maxReplicas: 1,
				metadata: { name: "Limited" },
			});
			await handleMint(mintOp, sql);

			// First distribute — ok
			const op1 = makeOp("distribute", {
				seedId: "seed_limited",
				instanceId: "nft_limited_1_a",
				to: "bob",
				instanceNumber: 1,
			});
			await handleDistribute(op1, sql);

			// Second distribute — should fail
			const op2 = makeOp("distribute", {
				seedId: "seed_limited",
				instanceId: "nft_limited_2_b",
				to: "charlie",
				instanceNumber: 2,
			});
			await expect(handleDistribute(op2, sql)).rejects.toThrow("max supply");
		});
	});

	// ─── transfer ───────────────────────────────────

	describe("transfer", () => {
		test("transfers NFT to new owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp("transfer", { nftId: "seed_test1", to: "bob" });
			await handleTransfer(op, sql);

			const [nft] = await sql`SELECT owner FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("bob");
		});

		test("rejects transfer by non-owner", async () => {
			await seedCollection();
			await seedMint();

			const op = makeOp("transfer", { nftId: "seed_test1", to: "bob" }, "eve");
			await expect(handleTransfer(op, sql)).rejects.toThrow("not owner");
		});

		test("rejects transfer of burned NFT", async () => {
			await seedCollection();
			await seedMint();
			await handleBurn(makeOp("burn", { nftId: "seed_test1" }), sql);

			const op = makeOp("transfer", { nftId: "seed_test1", to: "bob" });
			await expect(handleTransfer(op, sql)).rejects.toThrow("burned");
		});
	});

	// ─── burn ───────────────────────────────────────

	describe("burn", () => {
		test("burns NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleBurn(makeOp("burn", { nftId: "seed_test1" }), sql);

			const [nft] = await sql`SELECT status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.status).toBe("burned");
		});

		test("rejects double burn", async () => {
			await seedCollection();
			await seedMint();
			await handleBurn(makeOp("burn", { nftId: "seed_test1" }), sql);
			await expect(
				handleBurn(makeOp("burn", { nftId: "seed_test1" }), sql),
			).rejects.toThrow("already burned");
		});
	});

	// ─── list / unlist / buy ────────────────────────

	describe("marketplace", () => {
		test("list → unlist cycle", async () => {
			await seedCollection();
			await seedMint();

			await handleList(makeOp("list", {
				nftId: "seed_test1",
				price: { amount: "10.000", currency: "HIVE" },
			}), sql);

			const [listed] = await sql`SELECT status, listing_price, listing_currency FROM nfts WHERE id = 'seed_test1'`;
			expect(listed!.status).toBe("listed");
			expect(Number(listed!.listing_price)).toBe(10);
			expect(listed!.listing_currency).toBe("HIVE");

			await handleUnlist(makeOp("unlist", { nftId: "seed_test1" }), sql);

			const [unlisted] = await sql`SELECT status, listing_price FROM nfts WHERE id = 'seed_test1'`;
			expect(unlisted!.status).toBe("active");
			expect(unlisted!.listing_price).toBeNull();
		});

		test("buy transfers ownership and unlists", async () => {
			await seedCollection();
			await seedMint();

			await handleList(makeOp("list", {
				nftId: "seed_test1",
				price: { amount: "5.000", currency: "HIVE" },
			}), sql);

			await handleBuy(makeOp("buy", {
				nftId: "seed_test1",
				paymentTxId: "pay_001",
			}, "bob"), sql);

			const [nft] = await sql`SELECT owner, status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.owner).toBe("bob");
			expect(nft!.status).toBe("active");
		});

		test("rejects buy on own NFT", async () => {
			await seedCollection();
			await seedMint();
			await handleList(makeOp("list", {
				nftId: "seed_test1",
				price: { amount: "5.000", currency: "HIVE" },
			}), sql);

			await expect(
				handleBuy(makeOp("buy", { nftId: "seed_test1" }, "alice"), sql),
			).rejects.toThrow("Cannot buy own");
		});
	});

	// ─── lending ────────────────────────────────────

	describe("nft_lend / nft_return", () => {
		test("lend sets status to lent", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp("nft_lend", {
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

			await handleNftLend(makeOp("nft_lend", {
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

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await handleNftReturn(makeOp("nft_return", {
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

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await handleNftReturn(makeOp("nft_return", {
				instanceId: "seed_test1",
			}, "bob"), sql); // bob (borrower) returns

			const [nft] = await sql`SELECT status FROM nfts WHERE id = 'seed_test1'`;
			expect(nft!.status).toBe("active");
		});

		test("rejects lend to yourself", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				handleNftLend(makeOp("nft_lend", {
					instanceId: "seed_test1",
					borrower: "alice",
				}), sql),
			).rejects.toThrow("Cannot lend to yourself");
		});

		test("rejects lend by non-owner", async () => {
			await seedCollection();
			await seedMint();

			await expect(
				handleNftLend(makeOp("nft_lend", {
					instanceId: "seed_test1",
					borrower: "charlie",
				}, "eve"), sql),
			).rejects.toThrow("not owner");
		});

		test("rejects double lend", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleNftLend(makeOp("nft_lend", {
					instanceId: "seed_test1",
					borrower: "charlie",
				}), sql),
			).rejects.toThrow("must be active");
		});

		test("rejects return by stranger", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleNftReturn(makeOp("nft_return", {
					instanceId: "seed_test1",
				}, "eve"), sql),
			).rejects.toThrow("neither lender nor borrower");
		});

		// ─── lent guards ────────────────────────────

		test("rejects transfer of lent NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleTransfer(makeOp("transfer", {
					nftId: "seed_test1",
					to: "charlie",
				}), sql),
			).rejects.toThrow("lent");
		});

		test("rejects burn of lent NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleBurn(makeOp("burn", { nftId: "seed_test1" }), sql),
			).rejects.toThrow("lent");
		});

		test("rejects list of lent NFT", async () => {
			await seedCollection();
			await seedMint();

			await handleNftLend(makeOp("nft_lend", {
				instanceId: "seed_test1",
				borrower: "bob",
			}), sql);

			await expect(
				handleList(makeOp("list", {
					nftId: "seed_test1",
					price: { amount: "10.000", currency: "HIVE" },
				}), sql),
			).rejects.toThrow("lent");
		});
	});
});

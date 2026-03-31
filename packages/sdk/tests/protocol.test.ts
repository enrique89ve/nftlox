import { test, expect, describe } from "bun:test";

import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	MAX_JSON_SIZE,
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_MINT,
	ACTION_LIST,
	ACTION_BULK_DISTRIBUTE,
	MULTISIG_EXPIRATION_MS,
	MAX_MULTISIG_OPERATIONS,
	generateOriginDna,
	generateInstanceDna,
	generateReplicaInstanceDna,
	generateAccessKey,
	generateReplicaId,
	extractOriginalId,
	isReplicaId,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
	ACCESS_KEY_LENGTH,
	createListPayload,
	createBuyPayload,
	createBuyOperation,
	buildBuy,
	symbolSchema,
	priceSchema,
	createCollectionInputSchema,
	mintInputSchema,
	estimateOperationSize,
	createBulkDistributePayload,
	toHiveOperation,
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	createDeterministicMintOperation,
	createArchiveCollectionPayload,
	createArchiveCollectionOperation,
	type BuyData,
	type ArchiveCollectionInput,
	type DeterministicCollectionInput,
	type DeterministicMintInput,
} from "../src/index";

describe("Protocol Version", () => {
	test("version should be 0.4.1", () => {
		expect(PROTOCOL_VERSION).toBe("0.4.1");
	});
});

describe("Origin DNA Generation", () => {
	test("generateOriginDna should be deterministic", async () => {
		const collectionId = "col_test123";
		const dna1 = await generateOriginDna(collectionId);
		const dna2 = await generateOriginDna(collectionId);

		expect(dna1).toBe(dna2);
		expect(dna1.length).toBe(ORIGIN_DNA_LENGTH);
	});

	test("different collections should have different origin DNA", async () => {
		const dna1 = await generateOriginDna("col_abc");
		const dna2 = await generateOriginDna("col_xyz");

		expect(dna1).not.toBe(dna2);
	});

	test("origin DNA should start with 'o' prefix and be uppercase hex after", async () => {
		const dna = await generateOriginDna("col_test");
		expect(dna.startsWith("o")).toBe(true);
		expect(dna.slice(1)).toBe(dna.slice(1).toUpperCase());
	});
});

describe("Instance DNA Generation", () => {
	test("generateInstanceDna should be deterministic", async () => {
		const dna1 = await generateInstanceDna("seed_abc", "ABCD1234EFGH5678", 1, "hash1");
		const dna2 = await generateInstanceDna("seed_abc", "ABCD1234EFGH5678", 1, "hash1");

		expect(dna1).toBe(dna2);
		expect(dna1.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("generateInstanceDna should differ with different nftId", async () => {
		const dna1 = await generateInstanceDna("seed_abc", "ABCD1234EFGH5678", 1, "hash1");
		const dna2 = await generateInstanceDna("seed_def", "ABCD1234EFGH5678", 1, "hash1");

		expect(dna1).not.toBe(dna2);
	});

	test("generateInstanceDna should differ with different edition", async () => {
		const dna1 = await generateInstanceDna("seed_abc", "ABCD1234EFGH5678", 1, "hash1");
		const dna2 = await generateInstanceDna("seed_abc", "ABCD1234EFGH5678", 2, "hash1");

		expect(dna1).not.toBe(dna2);
	});

	test("generateInstanceDna should have correct length", async () => {
		const dna = await generateInstanceDna("seed_test", "ORIGIN123456", 1, "imagehash");
		expect(dna.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("replica instance DNA should be deterministic", async () => {
		const originDna = "ORIGIN123456";
		const originalInstanceDna = "INSTANCE123456";

		const replica1 = await generateReplicaInstanceDna(originDna, originalInstanceDna);
		const replica2 = await generateReplicaInstanceDna(originDna, originalInstanceDna);

		expect(replica1).toBe(replica2);
		expect(replica1.length).toBe(INSTANCE_DNA_LENGTH);
	});
});

describe("Access Key Generation", () => {
	test("access keys should be deterministic", async () => {
		const instanceDna = "INSTANCE123456";
		const key1 = await generateAccessKey(instanceDna, "user1");
		const key2 = await generateAccessKey(instanceDna, "user1");

		expect(key1).toBe(key2);
	});

	test("access keys should differ with different owners", async () => {
		const instanceDna = "INSTANCE123456";
		const key1 = await generateAccessKey(instanceDna, "user1");
		const key2 = await generateAccessKey(instanceDna, "user2");

		expect(key1).not.toBe(key2);
	});

	test("access key should have length 8", async () => {
		const key = await generateAccessKey("DNA123", "owner");
		expect(key.length).toBe(8);
	});
});

describe("Deterministic Instance DNA (SHA-256)", () => {
	test("should be deterministic", async () => {
		const dna1 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90000);
		const dna2 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90000);
		expect(dna1).toBe(dna2);
	});

	test("should have correct length", async () => {
		const dna = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90000);
		expect(dna.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("should start with 'i' prefix and be uppercase hex after", async () => {
		const dna = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90000);
		expect(dna.startsWith("i")).toBe(true);
		expect(dna.slice(1)).toBe(dna.slice(1).toUpperCase());
	});

	test("should differ with different txId", async () => {
		const dna1 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_aaa", 90000);
		const dna2 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_bbb", 90000);
		expect(dna1).not.toBe(dna2);
	});

	test("should differ with different instanceNumber", async () => {
		const dna1 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90000);
		const dna2 = await generateDeterministicInstanceDna("seed_abc", 2, "tx_123", 90000);
		expect(dna1).not.toBe(dna2);
	});

	test("should differ with different blockNum", async () => {
		const dna1 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90000);
		const dna2 = await generateDeterministicInstanceDna("seed_abc", 1, "tx_123", 90001);
		expect(dna1).not.toBe(dna2);
	});
});

describe("Deterministic Access Key (SHA-256)", () => {
	test("should be deterministic", async () => {
		const key1 = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_123");
		const key2 = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_123");
		expect(key1).toBe(key2);
	});

	test("should have correct length", async () => {
		const key = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_123");
		expect(key.length).toBe(ACCESS_KEY_LENGTH);
	});

	test("should be uppercase", async () => {
		const key = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_123");
		expect(key).toBe(key.toUpperCase());
	});

	test("should differ with different owner", async () => {
		const key1 = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_123");
		const key2 = await generateDeterministicAccessKey("ABCDEF12345678", "bob", "tx_123");
		expect(key1).not.toBe(key2);
	});

	test("should differ with different txId", async () => {
		const key1 = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_aaa");
		const key2 = await generateDeterministicAccessKey("ABCDEF12345678", "alice", "tx_bbb");
		expect(key1).not.toBe(key2);
	});
});

describe("ID Generation", () => {
	test("generateDeterministicCollectionId should create IDs with col_ prefix", async () => {
		const colId = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");

		expect(colId.startsWith("col_")).toBe(true);
	});

	test("generateDeterministicCollectionId should be deterministic", async () => {
		const id1 = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");
		const id2 = await generateDeterministicCollectionId("creator", "My Collection", "MYCOL");

		expect(id1).toBe(id2);
	});

	test("generateDeterministicSeedId should create IDs with seed_ prefix", async () => {
		const seedId = await generateDeterministicSeedId("col_test123", "art-01");

		expect(seedId.startsWith("seed_")).toBe(true);
	});

	test("generateDeterministicSeedId should be deterministic", async () => {
		const id1 = await generateDeterministicSeedId("col_test123", "art-01");
		const id2 = await generateDeterministicSeedId("col_test123", "art-01");

		expect(id1).toBe(id2);
	});

	test("different inputs should produce different deterministic IDs", async () => {
		const col1 = await generateDeterministicCollectionId("creator", "Collection A", "COLA");
		const col2 = await generateDeterministicCollectionId("creator", "Collection B", "COLB");

		expect(col1).not.toBe(col2);

		const seed1 = await generateDeterministicSeedId("col_test123", "art-01");
		const seed2 = await generateDeterministicSeedId("col_test123", "art-02");

		expect(seed1).not.toBe(seed2);
	});

	test("replica ID should contain original ID", async () => {
		const originalId = "nft_abc123";
		const replicaId = await generateReplicaId(originalId);

		expect(replicaId.startsWith(originalId)).toBe(true);
		expect(replicaId).toContain("_r");
	});

	test("extractOriginalId should work correctly", async () => {
		const originalId = "nft_abc123";
		const replicaId = await generateReplicaId(originalId);
		const extracted = extractOriginalId(replicaId);

		expect(extracted).toBe(originalId);
	});

	test("isReplicaId should identify replicas", async () => {
		const originalId = "nft_abc123";
		const replicaId = await generateReplicaId(originalId);

		expect(isReplicaId(originalId)).toBe(false);
		expect(isReplicaId(replicaId)).toBe(true);
	});
});

describe("Collection Payload", () => {
	const validInput: DeterministicCollectionInput = {
		name: "Test Collection",
		symbol: "TEST",
		creator: "testuser",
		totalPotential: 1000,
		metadata: {
			description: "A test collection",
			image: "https://example.com/image.png",
		},
		rules: {
			transferable: true,
			burnable: true,
			replicable: true,
			royaltyPct: 5,
		},
	};

	test("should create valid collection payload", async () => {
		const payload = await createDeterministicCollectionPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.4.1");
		expect(payload.action).toBe(ACTION_CREATE_COLLECTION);
		expect(payload.data.id.startsWith("col_")).toBe(true);
		expect(payload.data.originDna.length).toBe(ORIGIN_DNA_LENGTH);
	});

	test("collection payload should be under 8KB", async () => {
		const payload = await createDeterministicCollectionPayload(validInput);
		const size = new TextEncoder().encode(JSON.stringify(payload)).length;

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});
});

describe("Archive Collection Payload", () => {
	const validInput: ArchiveCollectionInput = {
		collectionId: "col_test123",
	};

	test("should create valid archive payload", () => {
		const payload = createArchiveCollectionPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.4.1");
		expect(payload.action).toBe(ACTION_ARCHIVE_COLLECTION);
		expect(payload.data.collectionId).toBe(validInput.collectionId);
	});

	test("archive operation should use posting auth", () => {
		const operation = createArchiveCollectionOperation(validInput, "alice");

		expect(operation[1].required_auths).toEqual([]);
		expect(operation[1].required_posting_auths).toEqual(["alice"]);
	});
});

describe("Mint Payload", () => {
	const validInput: DeterministicMintInput = {
		artId: "test-art-01",
		collectionId: "col_test123",
		collectionOriginDna: "ABCD1234EFGH5678",
		edition: 1,
		owner: "testuser",
		name: "Test NFT #1",
		description: "A test NFT",
		imageUrl: "https://example.com/nft1.png",
		collectionBlock: 90000000,
	};

	test("should create valid mint payload", async () => {
		const payload = await createDeterministicMintPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.4.1");
		expect(payload.action).toBe(ACTION_MINT);
		expect(payload.data.id.startsWith("seed_")).toBe(true);
		expect(payload.data.originDna).toBe("ABCD1234EFGH5678");
		expect(payload.data.instanceDna.length).toBe(INSTANCE_DNA_LENGTH);
		expect(payload.data.mintedBy).toBe("testuser");
	});

	test("mint payload should include collectionBlock", async () => {
		const payload = await createDeterministicMintPayload({
			...validInput,
			collectionBlock: 90000050,
		});

		expect(payload.data.collectionBlock).toBe(90000050);
	});

	test("mint payload should be under 8KB", async () => {
		const payload = await createDeterministicMintPayload(validInput);
		const size = new TextEncoder().encode(JSON.stringify(payload)).length;

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});

	test("mint operation should be under 8KB", async () => {
		const operation = await createDeterministicMintOperation(validInput);
		const size = estimateOperationSize(operation);

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});
});

describe("Marketplace Payloads", () => {
	test("list payload should include price and listingId", () => {
		const payload = createListPayload({
			nftId: "nft_test123",
			price: { amount: "10.000", currency: "HIVE" },
		}, "list_abc123", "nonce123");

		expect(payload.action).toBe(ACTION_LIST);
		expect(payload.data.price.amount).toBe("10.000");
		expect(payload.data.price.currency).toBe("HIVE");
		expect(payload.data.listingId).toBe("list_abc123");
		expect(payload.data.listingNonce).toBe("nonce123");
	});

});

describe("Validation", () => {
	describe("Symbol validation", () => {
		test("valid symbols should pass", () => {
			expect(symbolSchema.safeParse("TEST").success).toBe(true);
			expect(symbolSchema.safeParse("ABC123").success).toBe(true);
			expect(symbolSchema.safeParse("XYZ").success).toBe(true);
		});

		test("invalid symbols should fail", () => {
			expect(symbolSchema.safeParse("AB").success).toBe(false);
			expect(symbolSchema.safeParse("TOOLONGSYMBOL").success).toBe(false);
			expect(symbolSchema.safeParse("test!").success).toBe(false);
		});
	});

	describe("Price validation", () => {
		test("valid prices should pass", () => {
			expect(priceSchema.safeParse({ amount: "10.000", currency: "HIVE" }).success).toBe(true);
			expect(priceSchema.safeParse({ amount: "1.000", currency: "HBD" }).success).toBe(true);
		});

		test("invalid prices should fail", () => {
			expect(priceSchema.safeParse({ amount: "0", currency: "HIVE" }).success).toBe(false);
			expect(priceSchema.safeParse({ amount: "10", currency: "BTC" as any }).success).toBe(false);
		});
	});

	describe("Collection input validation", () => {
		const validInput = {
			name: "Test",
			symbol: "TEST",
			creator: "user",
			totalPotential: 100,
			metadata: {
				description: "Test desc",
				image: "https://example.com/img.png",
			},
			rules: {
				transferable: true,
				burnable: true,
				replicable: true,
				royaltyPct: 5,
			},
		};

		test("valid input should pass", () => {
			expect(createCollectionInputSchema.safeParse(validInput).success).toBe(true);
		});

		test("excessive royalty should fail", () => {
			const invalid = {
				...validInput,
				rules: { ...validInput.rules, royaltyPct: 60 },
			};
			expect(createCollectionInputSchema.safeParse(invalid).success).toBe(false);
		});
	});

	describe("Mint input validation", () => {
		const validInput = {
			collectionId: "col_test",
			collectionOriginDna: "ORIGIN1234567890",
			edition: 1,
			owner: "user",
			name: "NFT #1",
			imageUrl: "https://example.com/nft.png",
			collectionBlock: 90000000,
		};

		test("valid input should pass", () => {
			expect(mintInputSchema.safeParse(validInput).success).toBe(true);
		});

		test("missing origin DNA should fail", () => {
			const invalid = { ...validInput, collectionOriginDna: "" };
			expect(mintInputSchema.safeParse(invalid).success).toBe(false);
		});

		test("invalid edition should fail", () => {
			const invalid = { ...validInput, edition: 0 };
			expect(mintInputSchema.safeParse(invalid).success).toBe(false);
		});
	});
});

describe("NFT DNA Inheritance", () => {
	test("NFTs from same collection should share originDna", async () => {
		const collectionId = "col_shared";
		const originDna = await generateOriginDna(collectionId);

		const mint1: DeterministicMintInput = {
			artId: "art-01",
			collectionId,
			collectionOriginDna: originDna,
			edition: 1,
			owner: "user1",
			name: "NFT #1",
			imageUrl: "https://example.com/1.png",
			collectionBlock: 90000000,
		};

		const mint2: DeterministicMintInput = {
			artId: "art-02",
			collectionId,
			collectionOriginDna: originDna,
			edition: 2,
			owner: "user2",
			name: "NFT #2",
			imageUrl: "https://example.com/2.png",
			collectionBlock: 90000000,
		};

		const payload1 = await createDeterministicMintPayload(mint1);
		const payload2 = await createDeterministicMintPayload(mint2);

		expect(payload1.data.originDna).toBe(payload2.data.originDna);
		expect(payload1.data.instanceDna).not.toBe(payload2.data.instanceDna);
	});

	test("NFTs from different collections should have different originDna", async () => {
		const origin1 = await generateOriginDna("col_alpha");
		const origin2 = await generateOriginDna("col_beta");

		expect(origin1).not.toBe(origin2);
	});
});

describe("Bulk Distribute Payload", () => {
	test("should include seedTxId per item", () => {
		const payload = createBulkDistributePayload({
			to: "bob",
			items: [
				{ seedId: "seed_abc", quantity: 3, seedTxId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
				{ seedId: "seed_def", quantity: 1, seedTxId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
			],
		});

		expect(payload.action).toBe(ACTION_BULK_DISTRIBUTE);
		expect(payload.data.items[0]!.seedTxId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(payload.data.items[1]!.seedTxId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
	});

	test("should preserve all item fields", () => {
		const payload = createBulkDistributePayload({
			items: [
				{ seedId: "seed_xyz", quantity: 5, seedTxId: "cccccccccccccccccccccccccccccccccccccccc" },
			],
		});

		expect(payload.data.items[0]!.seedId).toBe("seed_xyz");
		expect(payload.data.items[0]!.quantity).toBe(5);
		expect(payload.data.items[0]!.seedTxId).toBe("cccccccccccccccccccccccccccccccccccccccc");
	});
});

describe("Buy Action (Multisig)", () => {
	test("ACTION_BUY should equal 'buy'", () => {
		expect(ACTION_BUY).toBe("buy");
	});

	test("MULTISIG_EXPIRATION_MS should be 125 seconds", () => {
		expect(MULTISIG_EXPIRATION_MS).toBe(125_000);
	});

	test("MAX_MULTISIG_OPERATIONS should be 4", () => {
		expect(MAX_MULTISIG_OPERATIONS).toBe(4);
	});

	test("createBuyPayload should produce valid payload with listingId and listTxId", () => {
		const data: BuyData = { nftId: "nft_test123", listingId: "list_abc123", listTxId: "a".repeat(40), txId: "c".repeat(40) };
		const payload = createBuyPayload(data);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.4.1");
		expect(payload.action).toBe(ACTION_BUY);
		expect(payload.data.nftId).toBe("nft_test123");
		expect(payload.data.listingId).toBe("list_abc123");
		expect(payload.data.listTxId).toBe("a".repeat(40));
	});

	test("createBuyOperation should use nodeAccount in required_auths", () => {
		const data: BuyData = { nftId: "nft_test123", listingId: "list_abc123", listTxId: "a".repeat(40), txId: "c".repeat(40) };
		const operation = createBuyOperation(data, "indexer-node");

		expect(operation[0]).toBe("custom_json");
		expect(operation[1].required_auths).toEqual(["indexer-node"]);
		expect(operation[1].required_posting_auths).toEqual([]);
		expect(operation[1].id).toBe("nftlox_testnet");

		const parsed = JSON.parse(operation[1].json);
		expect(parsed.action).toBe(ACTION_BUY);
		expect(parsed.data.nftId).toBe("nft_test123");
		expect(parsed.data.listingId).toBe("list_abc123");
	});

	test("buy operation payload should be under 8KB", () => {
		const data: BuyData = { nftId: "nft_test123", listingId: "list_abc123", listTxId: "a".repeat(40), txId: "c".repeat(40) };
		const operation = createBuyOperation(data, "indexer-node");
		const size = estimateOperationSize(operation);

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});
});

describe("buildBuy Transfer Generation", () => {
	const NFT_ID = "nft_buy_test_001";
	const LISTING_ID = "list_buy_test_001";
	const LIST_TX_ID = "b".repeat(40);
	const BUYER = "buyeraccount";
	const SELLER = "selleraccount";
	const NODE_ACCOUNT = "indexernode";
	const FEE_ACCOUNT = "nftloxfees";

	const basePaymentSplit = {
		sellerAmount: 8.9,
		royaltyAmount: 0,
		royaltyRecipient: null,
		feeAmount: 0.1,
		feeAccount: FEE_ACCOUNT,
		totalPrice: 9,
		currency: "HIVE" as const,
	};

	const NFT_TX_ID = "c".repeat(40);

	const baseInput = {
		nftId: NFT_ID,
		listingId: LISTING_ID,
		listTxId: LIST_TX_ID,
		txId: NFT_TX_ID,
		buyer: BUYER,
		seller: SELLER,
		nodeAccount: NODE_ACCOUNT,
		paymentSplit: basePaymentSplit,
	};

	test("generates seller + fee transfers when no royalty is present", () => {
		const result = buildBuy(baseInput);

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.hiveOperations!;
		expect(ops).toHaveLength(3);
		expect(ops[0]![0]).toBe("transfer");
		expect(ops[1]![0]).toBe("transfer");
		expect(ops[2]![0]).toBe("custom_json");
	});

	test("generates seller + royalty + fee transfers (full split)", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 7.9,
				royaltyAmount: 1.0,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.1,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.hiveOperations!;
		expect(ops).toHaveLength(4);

		const transferOps = ops.slice(0, -1);
		expect(transferOps.every((op) => op[0] === "transfer")).toBe(true);
		expect(ops[ops.length - 1]![0]).toBe("custom_json");
	});

	test("skips royalty transfer when royaltyAmount is 0", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 8.9,
				royaltyAmount: 0,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.1,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.hiveOperations!;
		const transferMemos = ops
			.filter((op): op is typeof op & { 0: "transfer" } => op[0] === "transfer")
			.map((op) => op[1].memo);

		expect(transferMemos).not.toContain(expect.stringContaining("NFTLox ROY:"));
		expect(ops).toHaveLength(3);
	});

	test("skips fee transfer when feeAmount is 0", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 9.0,
				royaltyAmount: 0,
				royaltyRecipient: null,
				feeAmount: 0,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.hiveOperations!;
		const transferMemos = ops
			.filter((op): op is typeof op & { 0: "transfer" } => op[0] === "transfer")
			.map((op) => op[1].memo);

		expect(transferMemos).not.toContain(expect.stringContaining("NFTLox FEE:"));
		expect(ops).toHaveLength(2);
	});

	test("transfer memos use correct NFTLox BUY/ROY/FEE prefixes", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 7.9,
				royaltyAmount: 1.0,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.1,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.hiveOperations!;
		const transfers = ops.filter((op): op is typeof op & { 0: "transfer" } => op[0] === "transfer");

		expect(transfers[0]![1].memo).toBe(`NFTLox BUY:${NFT_ID}`);
		expect(transfers[0]![1].to).toBe(SELLER);

		expect(transfers[1]![1].memo).toBe(`NFTLox ROY:${NFT_ID}`);
		expect(transfers[1]![1].to).toBe("royaltyuser");

		expect(transfers[2]![1].memo).toBe(`NFTLox FEE:${NFT_ID}`);
		expect(transfers[2]![1].to).toBe(FEE_ACCOUNT);
	});

	test("all transfers come from buyer", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 7.9,
				royaltyAmount: 0.5,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.6,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.hiveOperations!;
		const transfers = ops.filter((op): op is typeof op & { 0: "transfer" } => op[0] === "transfer");

		expect(transfers.length).toBeGreaterThan(0);
		for (const transfer of transfers) {
			expect(transfer[1].from).toBe(BUYER);
		}
	});
});

describe("toHiveOperation", () => {
	const mintInput: DeterministicMintInput = {
		artId: "test-art-01",
		collectionId: "col_test123",
		collectionOriginDna: "ABCD1234EFGH5678",
		edition: 1,
		owner: "testuser",
		name: "Test NFT",
		imageUrl: "https://example.com/nft.png",
		collectionBlock: 90000000,
	};

	test("converts payload to custom_json operation tuple", async () => {
		const payload = await createDeterministicMintPayload(mintInput);

		const operation = toHiveOperation(payload, "testuser");

		expect(operation[0]).toBe("custom_json");
		expect(operation[1].id).toBe(PROTOCOL_ID);
		expect(operation[1].required_auths).toEqual([]);
	});

	test("sets correct signer in required_posting_auths", async () => {
		const payload = await createDeterministicMintPayload(mintInput);

		const signer = "mysigner";
		const operation = toHiveOperation(payload, signer);

		expect(operation[1].required_posting_auths).toEqual([signer]);
	});

	test("serialized JSON matches original payload", async () => {
		const payload = await createDeterministicMintPayload(mintInput);

		const operation = toHiveOperation(payload, "testuser");
		const parsed = JSON.parse(operation[1].json);

		expect(parsed.protocol).toBe(payload.protocol);
		expect(parsed.version).toBe(payload.version);
		expect(parsed.action).toBe(payload.action);
		expect(parsed.data.id).toBe(payload.data.id);
		expect(parsed.data.collectionId).toBe(payload.data.collectionId);
	});
});

describe("Mint Payload (extended)", () => {
	const baseMintInput: DeterministicMintInput = {
		artId: "ext-art-01",
		collectionId: "col_test123",
		collectionOriginDna: "ABCD1234EFGH5678",
		edition: 1,
		owner: "testuser",
		name: "Test NFT #1",
		description: "A test NFT",
		imageUrl: "https://example.com/nft1.png",
		collectionBlock: 90000000,
	};

	test("immutableData is included when provided", async () => {
		const payload = await createDeterministicMintPayload({
			...baseMintInput,
			immutableData: { rarity: "legendary", power: 42 },
		});

		expect(payload.data.immutableData).toEqual({ rarity: "legendary", power: 42 });
	});

	test("mutableData is included when provided", async () => {
		const payload = await createDeterministicMintPayload({
			...baseMintInput,
			mutableData: { level: 1, experience: 0 },
		});

		expect(payload.data.mutableData).toEqual({ level: 1, experience: 0 });
	});

	test("immutableData and mutableData are omitted when not provided", async () => {
		const payload = await createDeterministicMintPayload(baseMintInput);

		expect(payload.data.immutableData).toBeUndefined();
		expect(payload.data.mutableData).toBeUndefined();
	});

	test("nftType is included when provided", async () => {
		const payload = await createDeterministicMintPayload({
			...baseMintInput,
			nftType: "seed",
		});

		expect(payload.data.nftType).toBe("seed");
	});

	test("nftType is omitted when not provided", async () => {
		const payload = await createDeterministicMintPayload(baseMintInput);

		expect(payload.data.nftType).toBeUndefined();
	});

	test("createdAt is NOT present in payload", async () => {
		const payload = await createDeterministicMintPayload(baseMintInput);

		expect("createdAt" in payload.data).toBe(false);
	});
});

describe("Deterministic Collection Payloads", () => {
	const baseCollectionInput: DeterministicCollectionInput = {
		creator: "testcreator",
		name: "Deterministic Col",
		symbol: "DETCOL",
		totalPotential: 500,
		metadata: {
			description: "A deterministic collection",
			image: "https://example.com/col.png",
		},
		rules: {
			transferable: true,
			burnable: true,
			replicable: false,
			royaltyPct: 10,
		},
	};

	test("same inputs produce same ID (deterministic)", async () => {
		const payload1 = await createDeterministicCollectionPayload(baseCollectionInput);
		const payload2 = await createDeterministicCollectionPayload(baseCollectionInput);

		expect(payload1.data.id).toBe(payload2.data.id);
	});

	test("createdAt is NOT present", async () => {
		const payload = await createDeterministicCollectionPayload(baseCollectionInput);

		expect("createdAt" in payload.data).toBe(false);
	});

	test("schema is included when provided", async () => {
		const schema = {
			immutable: [{ name: "rarity", type: "string" as const }],
			mutable: [{ name: "level", type: "uint32" as const }],
		};

		const payload = await createDeterministicCollectionPayload({
			...baseCollectionInput,
			schema,
		});

		expect(payload.data.schema).toEqual(schema);
	});
});

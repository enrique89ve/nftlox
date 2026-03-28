import { test, expect, describe } from "bun:test";

import {
	PROTOCOL_VERSION,
	MAX_JSON_SIZE,
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_LIST,
	ACTION_BULK_DISTRIBUTE,
	MULTISIG_EXPIRATION_MS,
	MAX_MULTISIG_OPERATIONS,
	generateOriginDna,
	generateInstanceDna,
	generateReplicaInstanceDna,
	generateAccessKey,
	generateId,
	generateReplicaId,
	extractOriginalId,
	isReplicaId,
	createCollectionPayload,
	createMintPayload,
	createListPayload,
	createBuyPayload,
	createBuyOperation,
	symbolSchema,
	priceSchema,
	createCollectionInputSchema,
	mintInputSchema,
	estimateOperationSize,
	createMintOperation,
	createBulkDistributePayload,
	type CreateCollectionInput,
	type MintInput,
	type BuyData,
} from "../src/index";

describe("Protocol Version", () => {
	test("version should be 0.2.1", () => {
		expect(PROTOCOL_VERSION).toBe("0.3.0");
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

	test("origin DNA should be uppercase", async () => {
		const dna = await generateOriginDna("col_test");
		expect(dna).toBe(dna.toUpperCase());
	});
});

describe("Instance DNA Generation", () => {
	test("generateInstanceDna should produce unique values", async () => {
		const originDna = "ABCD1234EFGH5678";
		const dna1 = await generateInstanceDna(originDna, 1, "hash1");
		const dna2 = await generateInstanceDna(originDna, 1, "hash1");

		expect(dna1).not.toBe(dna2);
		expect(dna1.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("generateInstanceDna should have correct length", async () => {
		const dna = await generateInstanceDna("ORIGIN123456", 1, "imagehash");
		expect(dna.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("replica instance DNA should be unique", async () => {
		const originDna = "ORIGIN123456";
		const originalInstanceDna = "INSTANCE123456";

		const replica1 = await generateReplicaInstanceDna(originDna, originalInstanceDna);
		const replica2 = await generateReplicaInstanceDna(originDna, originalInstanceDna);

		expect(replica1).not.toBe(replica2);
		expect(replica1.length).toBe(INSTANCE_DNA_LENGTH);
	});
});

describe("Access Key Generation", () => {
	test("access keys should be unique", async () => {
		const instanceDna = "INSTANCE123456";
		const key1 = await generateAccessKey(instanceDna, "user1");
		const key2 = await generateAccessKey(instanceDna, "user1");

		expect(key1).not.toBe(key2);
	});

	test("access key should have length 8", async () => {
		const key = await generateAccessKey("DNA123", "owner");
		expect(key.length).toBe(8);
	});
});

describe("ID Generation", () => {
	test("generateId should create IDs with correct prefix", () => {
		const colId = generateId("col");
		const nftId = generateId("nft");

		expect(colId.startsWith("col_")).toBe(true);
		expect(nftId.startsWith("nft_")).toBe(true);
	});

	test("replica ID should contain original ID", () => {
		const originalId = "nft_abc123";
		const replicaId = generateReplicaId(originalId);

		expect(replicaId.startsWith(originalId)).toBe(true);
		expect(replicaId).toContain("_r");
	});

	test("extractOriginalId should work correctly", () => {
		const originalId = "nft_abc123";
		const replicaId = generateReplicaId(originalId);
		const extracted = extractOriginalId(replicaId);

		expect(extracted).toBe(originalId);
	});

	test("isReplicaId should identify replicas", () => {
		const originalId = "nft_abc123";
		const replicaId = generateReplicaId(originalId);

		expect(isReplicaId(originalId)).toBe(false);
		expect(isReplicaId(replicaId)).toBe(true);
	});
});

describe("Collection Payload", () => {
	const validInput: CreateCollectionInput = {
		jsonId: "test_collection_2024",
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
		const payload = await createCollectionPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.3.0");
		expect(payload.action).toBe(ACTION_CREATE_COLLECTION);
		expect(payload.data.id.startsWith("col_")).toBe(true);
		expect(payload.data.originDna.length).toBe(ORIGIN_DNA_LENGTH);
		expect(payload.data.jsonId).toBe("test_collection_2024");
	});

	test("collection payload should be under 8KB", async () => {
		const payload = await createCollectionPayload(validInput);
		const size = new TextEncoder().encode(JSON.stringify(payload)).length;

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});
});

describe("Mint Payload", () => {
	const validInput: MintInput = {
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
		const payload = await createMintPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.3.0");
		expect(payload.action).toBe(ACTION_MINT);
		expect(payload.data.id.startsWith("nft_")).toBe(true);
		expect(payload.data.originDna).toBe("ABCD1234EFGH5678");
		expect(payload.data.instanceDna.length).toBe(INSTANCE_DNA_LENGTH);
		expect(payload.data.mintedBy).toBe("testuser");
	});

	test("mint payload should include procedencia fields", async () => {
		const payload = await createMintPayload({
			...validInput,
			birthBlock: 12345,
			birthTx: "tx_abc123",
		});

		expect(payload.data.birthBlock).toBe(12345);
		expect(payload.data.birthTx).toBe("tx_abc123");
	});

	test("mint payload should include collectionBlock", async () => {
		const payload = await createMintPayload({
			...validInput,
			collectionBlock: 90000050,
		});

		expect(payload.data.collectionBlock).toBe(90000050);
	});

	test("mint payload should be under 8KB", async () => {
		const payload = await createMintPayload(validInput);
		const size = new TextEncoder().encode(JSON.stringify(payload)).length;

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});

	test("mint operation should be under 8KB", async () => {
		const operation = await createMintOperation(validInput);
		const size = estimateOperationSize(operation);

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});
});

describe("Marketplace Payloads", () => {
	test("list payload should include price", () => {
		const payload = createListPayload({
			nftId: "nft_test123",
			price: { amount: "10.000", currency: "HIVE" },
		});

		expect(payload.action).toBe(ACTION_LIST);
		expect(payload.data.price.amount).toBe("10.000");
		expect(payload.data.price.currency).toBe("HIVE");
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
		const validInput: CreateCollectionInput = {
			jsonId: "test_2024",
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

		test("missing jsonId should fail", () => {
			const invalid = { ...validInput, jsonId: "" };
			expect(createCollectionInputSchema.safeParse(invalid).success).toBe(false);
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
		const validInput: MintInput = {
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

		const mint1: MintInput = {
			collectionId,
			collectionOriginDna: originDna,
			edition: 1,
			owner: "user1",
			name: "NFT #1",
			imageUrl: "https://example.com/1.png",
			collectionBlock: 90000000,
		};

		const mint2: MintInput = {
			collectionId,
			collectionOriginDna: originDna,
			edition: 2,
			owner: "user2",
			name: "NFT #2",
			imageUrl: "https://example.com/2.png",
			collectionBlock: 90000000,
		};

		const payload1 = await createMintPayload(mint1);
		const payload2 = await createMintPayload(mint2);

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
	test("should include originBlock per item", () => {
		const payload = createBulkDistributePayload({
			to: "bob",
			items: [
				{ seedId: "seed_abc", quantity: 3, originBlock: 90000100 },
				{ seedId: "seed_def", quantity: 1, originBlock: 90000200 },
			],
		});

		expect(payload.action).toBe(ACTION_BULK_DISTRIBUTE);
		expect(payload.data.items[0]!.originBlock).toBe(90000100);
		expect(payload.data.items[1]!.originBlock).toBe(90000200);
	});

	test("should preserve all item fields", () => {
		const payload = createBulkDistributePayload({
			items: [
				{ seedId: "seed_xyz", quantity: 5, originBlock: 0 },
			],
		});

		expect(payload.data.items[0]!.seedId).toBe("seed_xyz");
		expect(payload.data.items[0]!.quantity).toBe(5);
		expect(payload.data.items[0]!.originBlock).toBe(0);
	});
});

describe("Buy Action (Multisig)", () => {
	test("ACTION_BUY should equal 'buy'", () => {
		expect(ACTION_BUY).toBe("buy");
	});

	test("MULTISIG_EXPIRATION_MS should be 60 seconds", () => {
		expect(MULTISIG_EXPIRATION_MS).toBe(60_000);
	});

	test("MAX_MULTISIG_OPERATIONS should be 4", () => {
		expect(MAX_MULTISIG_OPERATIONS).toBe(4);
	});

	test("createBuyPayload should produce valid payload", () => {
		const data: BuyData = { nftId: "nft_test123" };
		const payload = createBuyPayload(data);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.3.0");
		expect(payload.action).toBe(ACTION_BUY);
		expect(payload.data).toEqual({ nftId: "nft_test123" });
	});

	test("createBuyOperation should use nodeAccount in required_auths", () => {
		const data: BuyData = { nftId: "nft_test123" };
		const operation = createBuyOperation(data, "indexer-node");

		expect(operation[0]).toBe("custom_json");
		expect(operation[1].required_auths).toEqual(["indexer-node"]);
		expect(operation[1].required_posting_auths).toEqual([]);
		expect(operation[1].id).toBe("nftlox_testnet");

		const parsed = JSON.parse(operation[1].json);
		expect(parsed.action).toBe(ACTION_BUY);
		expect(parsed.data.nftId).toBe("nft_test123");
	});

	test("buy operation payload should be under 8KB", () => {
		const data: BuyData = { nftId: "nft_test123" };
		const operation = createBuyOperation(data, "indexer-node");
		const size = estimateOperationSize(operation);

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});
});

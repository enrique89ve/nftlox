import { test, expect, describe } from "bun:test";

import {
	PROTOCOL_VERSION,
	MAX_JSON_SIZE,
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	generateOriginDna,
	generateOriginDnaSync,
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
	createOfferPayload,
	validateSymbol,
	validatePrice,
	validateCollectionInput,
	validateMintInput,
	estimateOperationSize,
	createMintOperation,
	type CreateCollectionInput,
	type MintInput,
} from "../src/index";

describe("Protocol Version", () => {
	test("version should be 0.2.1", () => {
		expect(PROTOCOL_VERSION).toBe("0.2.1");
	});
});

describe("Origin DNA Generation", () => {
	test("generateOriginDnaSync should be deterministic", () => {
		const collectionId = "col_test123";
		const dna1 = generateOriginDnaSync(collectionId);
		const dna2 = generateOriginDnaSync(collectionId);

		expect(dna1).toBe(dna2);
		expect(dna1.length).toBe(ORIGIN_DNA_LENGTH);
	});

	test("generateOriginDna (async) should be deterministic", async () => {
		const collectionId = "col_test123";
		const dna1 = await generateOriginDna(collectionId);
		const dna2 = await generateOriginDna(collectionId);

		expect(dna1).toBe(dna2);
		expect(dna1.length).toBe(ORIGIN_DNA_LENGTH);
	});

	test("different collections should have different origin DNA", () => {
		const dna1 = generateOriginDnaSync("col_abc");
		const dna2 = generateOriginDnaSync("col_xyz");

		expect(dna1).not.toBe(dna2);
	});

	test("origin DNA should be uppercase", () => {
		const dna = generateOriginDnaSync("col_test");
		expect(dna).toBe(dna.toUpperCase());
	});
});

describe("Instance DNA Generation", () => {
	test("generateInstanceDna should produce unique values", () => {
		const originDna = "ABCD1234EFGH5678";
		const dna1 = generateInstanceDna(originDna, 1, "hash1");
		const dna2 = generateInstanceDna(originDna, 1, "hash1");

		expect(dna1).not.toBe(dna2);
		expect(dna1.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("generateInstanceDna should have correct length", () => {
		const dna = generateInstanceDna("ORIGIN123456", 1, "imagehash");
		expect(dna.length).toBe(INSTANCE_DNA_LENGTH);
	});

	test("replica instance DNA should be unique", () => {
		const originDna = "ORIGIN123456";
		const originalInstanceDna = "INSTANCE123456";

		const replica1 = generateReplicaInstanceDna(originDna, originalInstanceDna);
		const replica2 = generateReplicaInstanceDna(originDna, originalInstanceDna);

		expect(replica1).not.toBe(replica2);
		expect(replica1.length).toBe(INSTANCE_DNA_LENGTH);
	});
});

describe("Access Key Generation", () => {
	test("access keys should be unique", () => {
		const instanceDna = "INSTANCE123456";
		const key1 = generateAccessKey(instanceDna, "user1");
		const key2 = generateAccessKey(instanceDna, "user1");

		expect(key1).not.toBe(key2);
	});

	test("access key should have length 8", () => {
		const key = generateAccessKey("DNA123", "owner");
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
			royaltyPct: 5,
		},
	};

	test("should create valid collection payload", () => {
		const payload = createCollectionPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.2.1");
		expect(payload.action).toBe("create_collection");
		expect(payload.data.id.startsWith("col_")).toBe(true);
		expect(payload.data.originDna.length).toBe(ORIGIN_DNA_LENGTH);
		expect(payload.data.jsonId).toBe("test_collection_2024");
	});

	test("collection payload should be under 8KB", () => {
		const payload = createCollectionPayload(validInput);
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
	};

	test("should create valid mint payload", () => {
		const payload = createMintPayload(validInput);

		expect(payload.protocol).toBe("nftlox_testnet");
		expect(payload.version).toBe("0.2.1");
		expect(payload.action).toBe("mint");
		expect(payload.data.id.startsWith("nft_")).toBe(true);
		expect(payload.data.originDna).toBe("ABCD1234EFGH5678");
		expect(payload.data.instanceDna.length).toBe(INSTANCE_DNA_LENGTH);
		expect(payload.data.mintedBy).toBe("testuser");
	});

	test("mint payload should include procedencia fields", () => {
		const payload = createMintPayload({
			...validInput,
			birthBlock: 12345,
			birthTx: "tx_abc123",
		});

		expect(payload.data.birthBlock).toBe(12345);
		expect(payload.data.birthTx).toBe("tx_abc123");
	});

	test("mint payload should be under 8KB", () => {
		const payload = createMintPayload(validInput);
		const size = new TextEncoder().encode(JSON.stringify(payload)).length;

		expect(size).toBeLessThan(MAX_JSON_SIZE);
	});

	test("mint operation should be under 8KB", () => {
		const operation = createMintOperation(validInput);
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

		expect(payload.action).toBe("list");
		expect(payload.data.price.amount).toBe("10.000");
		expect(payload.data.price.currency).toBe("HIVE");
	});

	test("buy payload should include payment tx", () => {
		const payload = createBuyPayload({
			nftId: "nft_test123",
			paymentTxId: "payment_tx_abc",
		});

		expect(payload.action).toBe("buy");
		expect(payload.data.paymentTxId).toBe("payment_tx_abc");
	});

	test("offer payload should generate offer ID", () => {
		const payload = createOfferPayload({
			nftId: "nft_test123",
			price: { amount: "5.000", currency: "HBD" },
		});

		expect(payload.action).toBe("offer");
		expect(payload.data.offerId.startsWith("offer_")).toBe(true);
	});
});

describe("Validation", () => {
	describe("Symbol validation", () => {
		test("valid symbols should pass", () => {
			expect(validateSymbol("TEST").valid).toBe(true);
			expect(validateSymbol("ABC123").valid).toBe(true);
			expect(validateSymbol("XYZ").valid).toBe(true);
		});

		test("invalid symbols should fail", () => {
			expect(validateSymbol("AB").valid).toBe(false);
			expect(validateSymbol("TOOLONGSYMBOL").valid).toBe(false);
			expect(validateSymbol("test!").valid).toBe(false);
		});
	});

	describe("Price validation", () => {
		test("valid prices should pass", () => {
			expect(validatePrice({ amount: "10.000", currency: "HIVE" }).valid).toBe(true);
			expect(validatePrice({ amount: "1.000", currency: "HBD" }).valid).toBe(true);
		});

		test("invalid prices should fail", () => {
			expect(validatePrice({ amount: "0", currency: "HIVE" }).valid).toBe(false);
			expect(validatePrice({ amount: "10", currency: "BTC" as any }).valid).toBe(false);
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
				royaltyPct: 5,
			},
		};

		test("valid input should pass", () => {
			expect(validateCollectionInput(validInput).valid).toBe(true);
		});

		test("missing jsonId should fail", () => {
			const invalid = { ...validInput, jsonId: "" };
			expect(validateCollectionInput(invalid).valid).toBe(false);
		});

		test("excessive royalty should fail", () => {
			const invalid = {
				...validInput,
				rules: { ...validInput.rules, royaltyPct: 60 },
			};
			expect(validateCollectionInput(invalid).valid).toBe(false);
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
		};

		test("valid input should pass", () => {
			expect(validateMintInput(validInput).valid).toBe(true);
		});

		test("missing origin DNA should fail", () => {
			const invalid = { ...validInput, collectionOriginDna: "" };
			expect(validateMintInput(invalid).valid).toBe(false);
		});

		test("invalid edition should fail", () => {
			const invalid = { ...validInput, edition: 0 };
			expect(validateMintInput(invalid).valid).toBe(false);
		});
	});
});

describe("NFT DNA Inheritance", () => {
	test("NFTs from same collection should share originDna", () => {
		const collectionId = "col_shared";
		const originDna = generateOriginDnaSync(collectionId);

		const mint1: MintInput = {
			collectionId,
			collectionOriginDna: originDna,
			edition: 1,
			owner: "user1",
			name: "NFT #1",
			imageUrl: "https://example.com/1.png",
		};

		const mint2: MintInput = {
			collectionId,
			collectionOriginDna: originDna,
			edition: 2,
			owner: "user2",
			name: "NFT #2",
			imageUrl: "https://example.com/2.png",
		};

		const payload1 = createMintPayload(mint1);
		const payload2 = createMintPayload(mint2);

		expect(payload1.data.originDna).toBe(payload2.data.originDna);
		expect(payload1.data.instanceDna).not.toBe(payload2.data.instanceDna);
	});

	test("NFTs from different collections should have different originDna", () => {
		const origin1 = generateOriginDnaSync("col_alpha");
		const origin2 = generateOriginDnaSync("col_beta");

		expect(origin1).not.toBe(origin2);
	});
});

import { test, expect, describe } from "bun:test";

import {
	buildArchiveCollection,
	buildCollection,
	buildSeed,
	type CreateCollectionInput,
} from "../src/index";

describe("buildCollection consistency", () => {
	const validInput: CreateCollectionInput = {
		name: "Builder Test Collection",
		symbol: "BTC01",
		creator: "testcreator",
		totalPotential: 1000,
		metadata: {
			description: "A collection for builder consistency tests",
			image: "https://example.com/collection.png",
		},
		rules: {
			transferable: true,
			burnable: true,
			royaltyPct: 5,
		},
	};

	test("returns success=true with valid input", async () => {
		const result = await buildCollection(validInput);

		expect(result.success).toBe(true);
	});

	test("generatedId matches payload.data.id", async () => {
		const result = await buildCollection(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.generatedId).toBe(result.payload.data.id);
	});

	test("payload.data.id matches the ID inside operation JSON", async () => {
		const result = await buildCollection(validInput);
		if (!result.success) throw new Error("Expected success");

		const parsed = JSON.parse(result.operation![1].json);

		expect(result.payload.data.id).toBe(parsed.data.id);
	});

	test("operation required_posting_auths equals [input.creator]", async () => {
		const result = await buildCollection(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.operation![1].required_posting_auths).toEqual([validInput.creator]);
	});

	test("schema appears in payload when provided", async () => {
		const schema = {
			immutable: [{ name: "rarity", type: "string" as const }],
			mutable: [{ name: "level", type: "uint32" as const }],
		};

		const result = await buildCollection({
			...validInput,
			schema,
		});
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.schema).toEqual(schema);
	});
});

describe("buildArchiveCollection consistency", () => {
	test("returns success=true with valid input", () => {
		const result = buildArchiveCollection({
			collectionId: "col_test_archive",
			creator: "testcreator",
		});

		expect(result.success).toBe(true);
	});

	test("payload collectionId matches operation JSON", () => {
		const result = buildArchiveCollection({
			collectionId: "col_test_archive",
			creator: "testcreator",
		});
		if (!result.success) throw new Error("Expected success");

		const parsed = JSON.parse(result.operation![1].json);
		expect(result.payload.data.collectionId).toBe(parsed.data.collectionId);
	});

	test("operation required_posting_auths equals [creator]", () => {
		const result = buildArchiveCollection({
			collectionId: "col_test_archive",
			creator: "testcreator",
		});
		if (!result.success) throw new Error("Expected success");

		expect(result.operation![1].required_posting_auths).toEqual(["testcreator"]);
	});
});

describe("buildSeed consistency", () => {
	const validInput = {
		artId: "art001",
		collectionId: "col_test_seed_builder",
		signer: "testcreator",
		owner: "testowner",
		edition: 1,
		name: "Seed Builder Test",
		imageUrl: "https://example.com/seed.png",
		maxSupply: 100,
	};

	test("returns success=true with valid input", async () => {
		const result = await buildSeed(validInput);

		expect(result.success).toBe(true);
	});

	test("generatedId matches payload.data.id", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.generatedId).toBe(result.payload.data.id);
	});

	test("payload.data.id starts with seed_", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.id.startsWith("seed_")).toBe(true);
	});

	test("payload.data.id matches the ID inside operation JSON", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		const parsed = JSON.parse(result.operation![1].json);

		expect(result.payload.data.id).toBe(parsed.data.id);
	});

	test("operation required_posting_auths equals [input.signer]", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.operation![1].required_posting_auths).toEqual([validInput.signer]);
	});

	test("payload.data.owner is the recipient, not the signer", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.owner).toBe("testowner");
		expect(result.operation![1].required_posting_auths).toEqual(["testcreator"]);
	});

	test("owner defaults to signer when not provided", async () => {
		const { owner: _, ...inputWithoutOwner } = validInput;
		const result = await buildSeed(inputWithoutOwner);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.owner).toBe("testcreator");
		expect(result.operation![1].required_posting_auths).toEqual(["testcreator"]);
	});

	test("nftType is seed in the payload", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.nftType).toBe("seed");
	});
});

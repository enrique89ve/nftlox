import { test, expect, describe } from "bun:test";

import {
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
			replicable: true,
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

describe("buildSeed consistency", () => {
	const validInput = {
		artId: "art001",
		collectionId: "col_test_seed_builder",
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

	test("operation required_posting_auths equals [input.owner]", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.operation![1].required_posting_auths).toEqual([validInput.owner]);
	});

	test("nftType is seed in the payload", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect((result.payload.data as Record<string, unknown>).nftType).toBe("seed");
	});
});

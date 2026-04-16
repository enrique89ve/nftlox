import { test, expect, describe } from "bun:test";

import {
	buildArchiveCollection,
	buildCollection,
	buildSeed,
	type CreateCollectionInput,
	type HiveOperation,
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

	test("generatedIds.collectionId matches payload.data.id", async () => {
		const result = await buildCollection(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.generatedIds?.collectionId).toBe(result.payload.data.id);
	});

	test("payload.data.id matches the ID inside operation JSON", async () => {
		const result = await buildCollection(validInput);
		if (!result.success) throw new Error("Expected success");

		const op = result.operations[0]! as HiveOperation;
		const parsed = JSON.parse(op[1].json);

		expect(result.payload.data.id).toBe(parsed.data.id);
	});

	test("create_collection uses active auth (required_auths=[creator])", async () => {
		const result = await buildCollection(validInput);
		if (!result.success) throw new Error("Expected success");

		const op = result.operations[0]! as HiveOperation;
		expect(op[1].required_auths).toEqual([validInput.creator]);
		expect(op[1].required_posting_auths).toEqual([]);
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

		const op = result.operations[0]! as HiveOperation;
		const parsed = JSON.parse(op[1].json);
		expect(result.payload.data.collectionId).toBe(parsed.data.collectionId);
	});

	test("archive_collection uses posting auth (required_posting_auths=[creator])", () => {
		const result = buildArchiveCollection({
			collectionId: "col_test_archive",
			creator: "testcreator",
		});
		if (!result.success) throw new Error("Expected success");

		const op = result.operations[0]! as HiveOperation;
		expect(op[1].required_posting_auths).toEqual(["testcreator"]);
		expect(op[1].required_auths).toEqual([]);
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

	test("generatedIds exposes the canonical seedId", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.generatedIds?.seedId?.startsWith("seed_")).toBe(true);
		expect(result.generatedIds?.seedId).toBe(result.payload.data.id);
	});

	test("payload.data.id is the canonical seedId (seed_*)", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.id.startsWith("seed_")).toBe(true);
	});

	test("payload.data.artId is forwarded for indexer canonical validation", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.artId).toBe(validInput.artId);
	});

	test("payload.data.id matches the ID inside operation JSON", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		const op = result.operations[0]! as HiveOperation;
		const parsed = JSON.parse(op[1].json);

		expect(result.payload.data.id).toBe(parsed.data.id);
	});

	test("operation required_posting_auths equals [input.signer]", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		const op = result.operations[0]! as HiveOperation;
		expect(op[1].required_posting_auths).toEqual([validInput.signer]);
	});

	test("payload.data.owner is the recipient, not the signer", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.owner).toBe("testowner");
		const op = result.operations[0]! as HiveOperation;
		expect(op[1].required_posting_auths).toEqual(["testcreator"]);
	});

	test("owner defaults to signer when not provided", async () => {
		const { owner: _, ...inputWithoutOwner } = validInput;
		const result = await buildSeed(inputWithoutOwner);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.owner).toBe("testcreator");
		const op = result.operations[0]! as HiveOperation;
		expect(op[1].required_posting_auths).toEqual(["testcreator"]);
	});

	test("nftType is seed in the payload", async () => {
		const result = await buildSeed(validInput);
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.nftType).toBe("seed");
	});
});

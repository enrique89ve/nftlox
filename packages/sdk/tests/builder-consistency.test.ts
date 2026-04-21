import { test, expect, describe } from "bun:test";

import {
	buildArchiveCollection,
	buildCollection,
	createIndexerClient,
	buildSeed,
	buildSeedBatch,
	resolveNodeAccountFromStatus,
	type CreateCollectionInput,
	type HiveOperation,
} from "../src/index";

type MockFetch = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

async function withMockFetch<T>(mockFetch: MockFetch, run: () => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mockFetch as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

const readyStatus = {
	protocolVersion: "0.6.3",
	protocolId: "nftlox_testnet",
	nodeAccount: "nftlox-node",
	nodeUrl: "https://indexer.test",
	nodeRegistered: true,
	nodeStatus: "active",
	nodeRegistrationBlock: 90,
	nodeLastHeartbeatBlock: 99,
	nodeActivityBlock: 99,
	nodeActivityAgeBlocks: 1,
	nodeActivityFresh: true,
	nodeActivityStaleAfterBlocks: 10000,
	multisigEnabled: true,
	multisigSignerReady: true,
	multisigClockDriftOk: true,
	lastBlock: 100,
	headBlock: 100,
	blocksBehind: 0,
	inSync: true,
};

describe("node account resolution", () => {
	test("extracts nodeAccount from status", () => {
		expect(resolveNodeAccountFromStatus(readyStatus)).toBe("nftlox-node");
	});

	test("requires multisig readiness when requested", () => {
		expect(() => resolveNodeAccountFromStatus({
			...readyStatus,
			multisigSignerReady: false,
		}, { requireMultisigReady: true })).toThrow("multisig signer is not ready");
	});

	test("requires fresh node activity when requested", () => {
		expect(() => resolveNodeAccountFromStatus({
			...readyStatus,
			nodeActivityFresh: false,
		}, { requireNodeActivity: true })).toThrow("has no fresh settlement heartbeat");
	});

	test("indexer client exposes explicit node account helpers", async () => {
		const mockFetch: MockFetch = async () => new Response(JSON.stringify(readyStatus), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		await withMockFetch(mockFetch, async () => {
			const client = createIndexerClient("https://indexer.test");
			expect(await client.getNodeAccount()).toBe("nftlox-node");
			expect(await client.getMultisigNodeAccount()).toBe("nftlox-node");
		});
	});
});

describe("buildCollection consistency", () => {
	const validInput: CreateCollectionInput = {
		name: "Builder Test Collection",
		symbol: "BTC01",
		creator: "testcreator",
		totalPotential: 1000,
		maxInstances: 0,
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
	const nodeAccount = "nftlox-node";

	test("returns success=true with valid input", async () => {
		const result = await buildCollection(validInput, { nodeAccount });

		expect(result.success).toBe(true);
	});

	test("fails when nodeAccount is not a valid Hive username", async () => {
		const result = await buildCollection(validInput, { nodeAccount: "NOT VALID" });
		expect(result.success).toBe(false);
		if (result.success) throw new Error("Expected failure");
		expect(result.errors[0]?.field).toBe("nodeAccount");
	});

	test("can resolve nodeAccount from indexerBaseUrl", async () => {
		const mockFetch: MockFetch = async () => new Response(JSON.stringify(readyStatus), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		await withMockFetch(mockFetch, async () => {
			const result = await buildCollection(validInput, { indexerBaseUrl: "https://indexer.test" });
			if (!result.success) throw new Error("Expected success");

			const transferOp = result.operations[0] as unknown as readonly ["transfer", Record<string, string>];
			const customJson = result.operations[1] as HiveOperation;

			expect(transferOp[1]?.to).toBe("nftlox-node");
			expect(customJson[1].required_auths).toEqual(["nftlox-node"]);
			expect(result.coSigners?.[0]?.account).toBe("nftlox-node");
		});
	});

	test("generatedIds.collectionId matches payload.data.id", async () => {
		const result = await buildCollection(validInput, { nodeAccount });
		if (!result.success) throw new Error("Expected success");

		expect(result.generatedIds?.collectionId).toBe(result.payload.data.id);
	});

	test("emits [transfer, custom_json] with payload id matching canonical id", async () => {
		const result = await buildCollection(validInput, { nodeAccount });
		if (!result.success) throw new Error("Expected success");

		expect(result.operations).toHaveLength(2);
		const [transfer, custom] = result.operations;
		expect(transfer?.[0]).toBe("transfer");
		expect(custom?.[0]).toBe("custom_json");

		const customJson = custom as HiveOperation;
		const parsed = JSON.parse(customJson[1].json);
		expect(result.payload.data.id).toBe(parsed.data.id);
	});

	test("transfer is creator → nodeAccount with the canonical fee amount and memo", async () => {
		const result = await buildCollection(validInput, { nodeAccount });
		if (!result.success) throw new Error("Expected success");

		const transferOp = result.operations[0] as unknown as readonly ["transfer", Record<string, string>];
		expect(transferOp[1]?.from).toBe(validInput.creator);
		expect(transferOp[1]?.to).toBe(nodeAccount);
		expect(transferOp[1]?.amount).toMatch(/^\d+\.\d{3} (HBD|HIVE)$/);
		expect(transferOp[1]?.memo).toBe(`NFTLox FEE-COL:${result.generatedIds?.collectionId}`);
	});

	test("custom_json required_auths is [nodeAccount] (node co-signs)", async () => {
		const result = await buildCollection(validInput, { nodeAccount });
		if (!result.success) throw new Error("Expected success");

		const customJson = result.operations[1] as HiveOperation;
		expect(customJson[1].required_auths).toEqual([nodeAccount]);
		expect(customJson[1].required_posting_auths).toEqual([]);
	});

	test("exposes coSigners pointing to op[1] = nodeAccount via multisig", async () => {
		const result = await buildCollection(validInput, { nodeAccount });
		if (!result.success) throw new Error("Expected success");

		expect(result.signer).toBe(validInput.creator);
		expect(result.keyType).toBe("Active");
		expect(result.coSigners).toEqual([{
			op: 1,
			account: nodeAccount,
			keyType: "Active",
			via: "multisig",
		}]);
	});

	test("schema appears in payload when provided", async () => {
		const schema = {
			immutable: [{ name: "rarity", type: "string" as const }],
			mutable: [{ name: "level", type: "uint32" as const }],
		};

		const result = await buildCollection({
			...validInput,
			schema,
		}, { nodeAccount });
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

	test("preserves immutableData in payload and custom_json", async () => {
		const immutableData = {
			card_id: 1001,
			rarity: "legendary",
			attack: 7,
			health: 5,
		};
		const result = await buildSeed({ ...validInput, immutableData });
		if (!result.success) throw new Error("Expected success");

		expect(result.payload.data.immutableData).toEqual(immutableData);
		const payloadData = result.payload.data as Record<string, unknown>;
		expect("schema" in payloadData).toBe(false);
		expect("mutableData" in payloadData).toBe(false);

		const op = result.operations[0]! as HiveOperation;
		const parsed = JSON.parse(op[1].json) as {
			readonly data: {
				readonly immutableData?: Record<string, unknown>;
			};
		};
		expect(parsed.data.immutableData).toEqual(immutableData);
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

	test("buildSeedBatch preserves immutableData per seed", async () => {
		const firstImmutableData = { card_id: 1001, rarity: "legendary" };
		const secondImmutableData = { card_id: 1002, rarity: "common" };
		const result = await buildSeedBatch({
			collectionId: validInput.collectionId,
			signer: validInput.signer,
			seeds: [
				{
					artId: "art-batch-001",
					name: "Batch Seed One",
					imageUrl: "https://example.com/batch-one.png",
					maxSupply: 10,
					immutableData: firstImmutableData,
				},
				{
					artId: "art-batch-002",
					name: "Batch Seed Two",
					imageUrl: "https://example.com/batch-two.png",
					maxSupply: 20,
					immutableData: secondImmutableData,
				},
			],
		});
		if (!result.success) throw new Error("Expected success");

		expect(result.seeds[0]?.immutableData).toEqual(firstImmutableData);
		expect(result.seeds[1]?.immutableData).toEqual(secondImmutableData);
	});
});

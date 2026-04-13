import { test, expect, describe } from "bun:test";

import {
	ALL_ACTIONS,
	ACTION_AUTH_LEVEL,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	isProtocolAction,
	getAuthLevel,
	getKeyType,
	// Operation factories
	createTransferOperation,
	createBurnOperation,
	createBulkDistributeOperation,
	createListOperation,
	createBuyOperation,
	createNodeRegisterOperation,
	createDeterministicCollectionOperation,
	createNftApproveOperation,
	createNftApproveAllOperation,
	createDataOperatorApproveOperation,
	// Posting operations
	createSetDataOperation,
	createArchiveCollectionOperation,
	createSetDataFromOperation,
	createUnlistOperation,
	createNftTransferFromOperation,
	createNftLendOperation,
	createNftReturnOperation,
	toHiveOperation,
	ACTION_TRANSFER,
} from "../src/index";

// ============ EXHAUSTIVENESS ============

describe("Authority exhaustiveness", () => {
	test("ACTIVE + POSTING covers ALL_ACTIONS exactly", () => {
		const active = new Set<string>(ACTIVE_AUTH_ACTIONS);
		const posting = new Set<string>(POSTING_AUTH_ACTIONS);
		const all = new Set<string>(ALL_ACTIONS);

		// No overlap
		const overlap = [...active].filter(a => posting.has(a));
		expect(overlap).toEqual([]);

		// Union equals ALL_ACTIONS
		const union = new Set([...active, ...posting]);
		expect(union.size).toBe(all.size);
		for (const action of all) {
			expect(union.has(action)).toBe(true);
		}
	});

	test("ACTION_AUTH_LEVEL keys exactly match ALL_ACTIONS", () => {
		expect(Object.keys(ACTION_AUTH_LEVEL).sort()).toEqual([...ALL_ACTIONS].sort());
	});

	test("runtime guard accepts only canonical protocol actions", () => {
		for (const action of ALL_ACTIONS) {
			expect(isProtocolAction(action)).toBe(true);
		}

		expect(isProtocolAction("pack_buy")).toBe(false);
		expect(isProtocolAction("burn")).toBe(false);
		expect(isProtocolAction("set_owner_data")).toBe(false);
		expect(isProtocolAction(null)).toBe(false);
		expect(() => getAuthLevel("pack_buy" as (typeof ALL_ACTIONS)[number])).toThrow("Unsupported protocol action: pack_buy");
		expect(() => getKeyType("pack_buy" as (typeof ALL_ACTIONS)[number])).toThrow("Unsupported protocol action: pack_buy");
	});

	test("no action appears in both ACTIVE and POSTING", () => {
		const active = new Set<string>(ACTIVE_AUTH_ACTIONS);
		for (const action of POSTING_AUTH_ACTIONS) {
			expect(active.has(action)).toBe(false);
		}
	});

	test("counts match: 2 active + 16 posting = 18 total", () => {
		expect(ACTIVE_AUTH_ACTIONS.length).toBe(2);
		expect(POSTING_AUTH_ACTIONS.length).toBe(16);
		expect(ALL_ACTIONS.length).toBe(18);
	});
});

// ============ ACTIVE KEY OPERATIONS ============

describe("Active key operations use required_auths", () => {
	test("create_collection", async () => {
		const op = await createDeterministicCollectionOperation({
			creator: "indexer-node",
			name: "Test Collection",
			symbol: "TEST",
			totalPotential: 100,
			metadata: { description: "Test", image: "https://example.com/image.png" },
			rules: { transferable: true, burnable: true, royaltyPct: 5 },
		});
		expect(op[1].required_auths).toEqual(["indexer-node"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("buy (node account)", () => {
		const op = createBuyOperation(
			{ nftId: "nft_1", listingId: "list_1", listTxId: "a".repeat(40), txId: "b".repeat(40) },
			"indexer-node",
		);
		expect(op[1].required_auths).toEqual(["indexer-node"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

});

// ============ POSTING KEY OPERATIONS ============

describe("Posting key operations use required_posting_auths", () => {
	test("transfer", () => {
		const op = createTransferOperation("nft_1", "alice", "bob");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("node_register", () => {
		const op = createNodeRegisterOperation(
			{ endpoint: "https://node.example.com", publicKey: "public-key-material" },
			"indexer-node",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["indexer-node"]);
	});

	test("burn", () => {
		const op = createBurnOperation("nft_1", "alice");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("list", () => {
		const op = createListOperation(
			{ nftId: "nft_1", price: { amount: "10.000", currency: "HIVE" } },
			"alice",
			"list_1",
			"nonce_1",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_approve", () => {
		const op = createNftApproveOperation(
			{ spender: "bob", instanceId: "nft_1", approved: true },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_approve_all", () => {
		const op = createNftApproveAllOperation(
			{ spender: "bob", collectionId: "col_1", approved: true },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("data_operator_approve", () => {
		const op = createDataOperatorApproveOperation(
			{ collectionId: "col_1", operator: "bob", approved: true },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("bulk_distribute", () => {
		const op = createBulkDistributeOperation(
			{ items: [{ seedId: "seed_1", quantity: 1, seedTxId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("set_data", () => {
		const op = createSetDataOperation(
			{ nftId: "nft_1", instanceDna: "dna_1" },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("archive_collection", () => {
		const op = createArchiveCollectionOperation(
			{ collectionId: "col_1" },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("set_data_from", () => {
		const op = createSetDataFromOperation(
			{ nftId: "nft_1", instanceDna: "dna_1" },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("unlist", () => {
		const op = createUnlistOperation("nft_1", "alice");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_transfer_from", () => {
		const op = createNftTransferFromOperation(
			{ from: "alice", to: "bob", instanceId: "nft_1" },
			"charlie",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["charlie"]);
	});

	test("nft_lend", () => {
		const op = createNftLendOperation(
			{ instanceId: "nft_1", borrower: "bob" },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_return", () => {
		const op = createNftReturnOperation(
			{ instanceId: "nft_1" },
			"alice",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("toHiveOperation (generic posting wrapper)", () => {
		const payload = { protocol: "test", version: "0.1", action: ACTION_TRANSFER, data: {} } as const;
		const op = toHiveOperation(payload, "alice");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});
});

import { test, expect, describe } from "bun:test";

import {
	ALL_ACTIONS,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	// Operation factories
	createTransferOperation,
	createBurnOperation,
	createBulkDistributeOperation,
	createListOperation,
	createBuyOperation,
	createPackBuyOperation,
	createPackTransferOperation,
	createPackApproveOperation,
	createNftApproveOperation,
	createNftApproveAllOperation,
	createDataOperatorApproveOperation,
	// Posting operations
	createSetDataOperation,
	createArchiveCollectionOperation,
	createSetDataFromOperation,
	createUnlistOperation,
	createPackOpenOperation,
	createPackTransferFromOperation,
	createNftTransferFromOperation,
	createNftLendOperation,
	createNftReturnOperation,
	toHiveOperation,
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

	test("no action appears in both ACTIVE and POSTING", () => {
		const active = new Set<string>(ACTIVE_AUTH_ACTIONS);
		for (const action of POSTING_AUTH_ACTIONS) {
			expect(active.has(action)).toBe(false);
		}
	});

	test("counts match: 2 active + 23 posting = 25 total", () => {
		expect(ACTIVE_AUTH_ACTIONS.length).toBe(2);
		expect(POSTING_AUTH_ACTIONS.length).toBe(23);
		expect(ALL_ACTIONS.length).toBe(25);
	});
});

// ============ ACTIVE KEY OPERATIONS ============

describe("Active key operations use required_auths (only buy/pack_buy)", () => {
	test("buy (node account)", () => {
		const op = createBuyOperation(
			{ nftId: "nft_1", listingId: "list_1", listTxId: "a".repeat(40), txId: "b".repeat(40) },
			"indexer-node",
		);
		expect(op[1].required_auths).toEqual(["indexer-node"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("pack_buy", () => {
		const op = createPackBuyOperation({ packId: "pack_1", quantity: 1 }, "alice");
		expect(op[1].required_auths).toEqual(["alice"]);
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

	test("pack_transfer", () => {
		const op = createPackTransferOperation({ packId: "pack_1", to: "bob", quantity: 1 }, "alice");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("pack_approve", () => {
		const op = createPackApproveOperation(
			{ spender: "bob", packId: "pack_1", quantity: 5, approved: true },
			"alice",
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

	test("pack_open", () => {
		const op = createPackOpenOperation({ packId: "pack_1", quantity: 1 }, "alice");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("pack_transfer_from", () => {
		const op = createPackTransferFromOperation(
			{ from: "alice", to: "bob", packId: "pack_1", quantity: 1 },
			"charlie",
		);
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["charlie"]);
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
		const payload = { protocol: "test", version: "0.1", action: "test", data: {} };
		const op = toHiveOperation(payload as any, "alice");
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});
});

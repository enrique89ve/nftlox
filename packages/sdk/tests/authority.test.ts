import { test, expect, describe } from "bun:test";

import {
	ALL_ACTIONS,
	ACTION_AUTH_LEVEL,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	isProtocolAction,
	getAuthLevel,
	getKeyType,
	createPayload,
	createHiveOperation,
	ACTION_TRANSFER,
	ACTION_CREATE_COLLECTION,
	ACTION_BUY,
	ACTION_NODE_REGISTER,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_SET_DATA_FROM,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	type ProtocolAction,
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
		expect(() => getAuthLevel("pack_buy" as ProtocolAction)).toThrow("Unsupported protocol action: pack_buy");
		expect(() => getKeyType("pack_buy" as ProtocolAction)).toThrow("Unsupported protocol action: pack_buy");
	});

	test("no action appears in both ACTIVE and POSTING", () => {
		const active = new Set<string>(ACTIVE_AUTH_ACTIONS);
		for (const action of POSTING_AUTH_ACTIONS) {
			expect(active.has(action)).toBe(false);
		}
	});

	test("counts match: 2 active + 17 posting = 19 total", () => {
		expect(ACTIVE_AUTH_ACTIONS.length).toBe(2);
		expect(POSTING_AUTH_ACTIONS.length).toBe(17);
		expect(ALL_ACTIONS.length).toBe(19);
	});
});

// ============ ACTIVE KEY OPERATIONS ============

function buildOp(action: ProtocolAction, signer: string, data: Record<string, unknown> = {}) {
	const payload = createPayload(action, data);
	return createHiveOperation(payload, signer);
}

describe("Active key operations use required_auths", () => {
	test("create_collection", () => {
		const op = buildOp(ACTION_CREATE_COLLECTION, "indexer-node", {
			id: "col_1",
			name: "Test Collection",
			symbol: "TEST",
			creator: "indexer-node",
			totalPotential: 100,
			maxInstances: 0,
			originDna: "a".repeat(32),
			metadata: { description: "Test", image: "https://example.com/image.png" },
			rules: { transferable: true, burnable: true, royaltyPct: 5 },
		});
		expect(op[1].required_auths).toEqual(["indexer-node"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("buy", () => {
		const op = buildOp(ACTION_BUY, "node-account", {
			nftId: "nft_1",
			listingId: "list_1",
			listTxId: "a".repeat(40),
			txId: "b".repeat(40),
		});
		expect(op[1].required_auths).toEqual(["node-account"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});
});

// ============ POSTING KEY OPERATIONS ============

describe("Posting key operations use required_posting_auths", () => {
	test("transfer", () => {
		const op = buildOp(ACTION_TRANSFER, "alice", { nftId: "nft_1", from: "alice", to: "bob" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("node_register", () => {
		const op = buildOp(ACTION_NODE_REGISTER, "indexer-node", {
			endpoint: "https://node.example.com",
			publicKey: "public-key-material",
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["indexer-node"]);
	});

	test("burn (transfer to null)", () => {
		const op = buildOp(ACTION_TRANSFER, "alice", { nftId: "nft_1", from: "alice", to: "null" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("list", () => {
		const op = buildOp(ACTION_LIST, "alice", {
			nftId: "nft_1",
			listingId: "list_1",
			listingNonce: "nonce_1",
			price: { amount: "10.000", currency: "HIVE" },
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_approve", () => {
		const op = buildOp(ACTION_NFT_APPROVE, "alice", {
			spender: "bob",
			instanceId: "nft_1",
			approved: true,
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_approve_all", () => {
		const op = buildOp(ACTION_NFT_APPROVE_ALL, "alice", {
			spender: "bob",
			collectionId: "col_1",
			approved: true,
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("data_operator_approve", () => {
		const op = buildOp(ACTION_DATA_OPERATOR_APPROVE, "alice", {
			collectionId: "col_1",
			operator: "bob",
			approved: true,
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("bulk_distribute", () => {
		const op = buildOp(ACTION_BULK_DISTRIBUTE, "alice", {
			items: [{ seedId: "seed_1", quantity: 1, seedTxId: "a".repeat(40) }],
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("set_data", () => {
		const op = buildOp(ACTION_SET_DATA, "alice", { nftId: "nft_1", instanceDna: "dna_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("archive_collection", () => {
		const op = buildOp(ACTION_ARCHIVE_COLLECTION, "alice", { collectionId: "col_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("set_data_from", () => {
		const op = buildOp(ACTION_SET_DATA_FROM, "alice", { nftId: "nft_1", instanceDna: "dna_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("unlist", () => {
		const op = buildOp(ACTION_UNLIST, "alice", { nftId: "nft_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_transfer_from", () => {
		const op = buildOp(ACTION_NFT_TRANSFER_FROM, "charlie", {
			from: "alice",
			to: "bob",
			instanceId: "nft_1",
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["charlie"]);
	});

	test("nft_lend", () => {
		const op = buildOp(ACTION_NFT_LEND, "alice", { instanceId: "nft_1", borrower: "bob" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("nft_return", () => {
		const op = buildOp(ACTION_NFT_RETURN, "alice", { instanceId: "nft_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});
});

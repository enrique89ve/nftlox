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
	ACTION_ASSET_APPROVE,
	ACTION_ASSET_APPROVE_ALL,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_ASSET_TRANSFER_FROM,
	ACTION_ASSET_LEND,
	ACTION_ASSET_RETURN,
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

		expect(isProtocolAction("unsupported_action")).toBe(false);
		expect(isProtocolAction("burn")).toBe(false);
		expect(isProtocolAction("set_owner_data")).toBe(false);
		expect(isProtocolAction(null)).toBe(false);
		expect(() => getAuthLevel("unsupported_action" as ProtocolAction)).toThrow("Unsupported protocol action: unsupported_action");
		expect(() => getKeyType("unsupported_action" as ProtocolAction)).toThrow("Unsupported protocol action: unsupported_action");
	});

	test("no action appears in both ACTIVE and POSTING", () => {
		const active = new Set<string>(ACTIVE_AUTH_ACTIONS);
		for (const action of POSTING_AUTH_ACTIONS) {
			expect(active.has(action)).toBe(false);
		}
	});

	test("counts match: 11 active + 10 posting = 21 total", () => {
		expect(ACTIVE_AUTH_ACTIONS.length).toBe(11);
		expect(POSTING_AUTH_ACTIONS.length).toBe(10);
		expect(ALL_ACTIONS.length).toBe(21);
	});
});

// ============ ACTIVE KEY OPERATIONS ============

// Test helper: this suite asserts auth-field emission across all actions, not
// data shape. The `as never` cast at the boundary lets each test pass minimal
// or partial data without dragging every action's full payload schema into
// every assertion. Runtime behavior of `createPayload + createHiveOperation`
// is what's under test here.
function buildOp(action: ProtocolAction, signer: string, data: Record<string, unknown> = {}) {
	const payload = createPayload(action, data as never);
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

});

// ============ AUTHORITY FIELD EMISSION ============

describe("Action authority fields follow ACTION_AUTH_LEVEL", () => {
	test("transfer", () => {
		const op = buildOp(ACTION_TRANSFER, "alice", { assetId: "asset_1", to: "bob" });
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("node_register", () => {
		const op = buildOp(ACTION_NODE_REGISTER, "indexer-node", {
			endpoint: "https://node.example.com",
		});
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["indexer-node"]);
	});

	test("burn (transfer to null)", () => {
		const op = buildOp(ACTION_TRANSFER, "alice", { assetId: "asset_1", to: "null" });
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("list", () => {
		const op = buildOp(ACTION_LIST, "alice", {
			assetId: "asset_1",
			listingId: "list_1",
			listingNonce: "nonce_1",
			price: { amount: "10.000", currency: "HIVE" },
		});
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("asset_approve", () => {
		const op = buildOp(ACTION_ASSET_APPROVE, "alice", {
			spender: "bob",
			instanceId: "asset_1",
			approved: true,
		});
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("asset_approve_all", () => {
		const op = buildOp(ACTION_ASSET_APPROVE_ALL, "alice", {
			spender: "bob",
			collectionId: "col_1",
			approved: true,
		});
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
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
		const op = buildOp(ACTION_SET_DATA, "alice", { assetId: "asset_1", assetDna: "dna_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("archive_collection", () => {
		const op = buildOp(ACTION_ARCHIVE_COLLECTION, "alice", { collectionId: "col_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("set_data_from", () => {
		const op = buildOp(ACTION_SET_DATA_FROM, "alice", { assetId: "asset_1", assetDna: "dna_1" });
		expect(op[1].required_auths).toEqual([]);
		expect(op[1].required_posting_auths).toEqual(["alice"]);
	});

	test("unlist", () => {
		const op = buildOp(ACTION_UNLIST, "alice", { assetId: "asset_1" });
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("asset_transfer_from", () => {
		const op = buildOp(ACTION_ASSET_TRANSFER_FROM, "charlie", {
			from: "alice",
			to: "bob",
			instanceId: "asset_1",
		});
		expect(op[1].required_auths).toEqual(["charlie"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("asset_lend", () => {
		const op = buildOp(ACTION_ASSET_LEND, "alice", { instanceId: "asset_1", borrower: "bob" });
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("asset_return", () => {
		const op = buildOp(ACTION_ASSET_RETURN, "alice", { instanceId: "asset_1" });
		expect(op[1].required_auths).toEqual(["alice"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});

	test("buy (node active auth)", () => {
		const op = buildOp(ACTION_BUY, "node-account", {
			assetId: "asset_1",
			listingId: "list_1",
			listTxId: "a".repeat(40),
		});
		expect(op[1].required_auths).toEqual(["node-account"]);
		expect(op[1].required_posting_auths).toEqual([]);
	});
});

import { describe, expect, test } from "bun:test";

import {
	ACTION_AUTH_LEVEL,
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_NODE_REGISTER,
	ACTION_TRANSFER,
	ACTIVE_AUTH_ACTIONS,
	ALL_ACTIONS,
	POSTING_AUTH_ACTIONS,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	PROTOCOL_GENESIS_BLOCK,
	getAuthMismatchReason,
	type ProtocolAction,
} from "@/protocol/index.ts";
import { parseHafAHOperations } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";

const TX_ID = "a".repeat(40);
const POST_GENESIS_BLOCK = PROTOCOL_GENESIS_BLOCK + 1;

function makeCustomJsonOperation(
	action: ProtocolAction,
	required_auths: string[],
	required_posting_auths: string[],
	version = PROTOCOL_VERSION,
	block = POST_GENESIS_BLOCK,
): HafAHOperation {
	return {
		op: {
			type: "custom_json",
			value: {
				id: PROTOCOL_ID,
				json: JSON.stringify({ protocol: PROTOCOL_ID, version, action, data: {} }),
				required_auths,
				required_posting_auths,
			},
		},
		block,
		trx_id: TX_ID,
		timestamp: "2026-01-01T00:00:00",
		operation_id: "1",
		virtual_op: false,
	};
}

describe("protocol auth map", () => {
	test("node_register uses posting custom_json auth", () => {
		expect(ACTION_AUTH_LEVEL[ACTION_NODE_REGISTER]).toBe("posting");
		expect(POSTING_AUTH_ACTIONS).toContain(ACTION_NODE_REGISTER);
		expect(ACTIVE_AUTH_ACTIONS).not.toContain(ACTION_NODE_REGISTER);
	});

	test("collection creation and buy use active custom_json auth", () => {
		expect(ACTION_AUTH_LEVEL[ACTION_CREATE_COLLECTION]).toBe("active");
		expect(ACTION_AUTH_LEVEL[ACTION_BUY]).toBe("active");
		expect(Object.isFrozen(ACTION_AUTH_LEVEL)).toBe(true);
		expect(ACTIVE_AUTH_ACTIONS).toEqual([ACTION_CREATE_COLLECTION, ACTION_BUY]);
		expect(POSTING_AUTH_ACTIONS).toHaveLength(17);
		expect(ALL_ACTIONS).toHaveLength(19);
	});

	test("pack actions are not native indexer protocol actions", () => {
		for (const action of ALL_ACTIONS) {
			expect(action).not.toContain("pack");
		}
	});

	test("auth mismatch messages are derived from the canonical map", () => {
		expect(getAuthMismatchReason(ACTION_BUY, "posting")).toBe("Action 'buy' requires active key authority, got posting");
		expect(getAuthMismatchReason(ACTION_CREATE_COLLECTION, "posting")).toBe("Action 'create_collection' requires active key authority, got posting");
		expect(getAuthMismatchReason(ACTION_NODE_REGISTER, "active")).toBe("Action 'node_register' requires posting key authority, got active");
		expect(getAuthMismatchReason(ACTION_NODE_REGISTER, "posting")).toBeNull();
	});
});

describe("protocol auth parser", () => {
	test("accepts node_register with exactly one posting signer", () => {
		const result = parseHafAHOperations([
			makeCustomJsonOperation(ACTION_NODE_REGISTER, [], ["indexer-node"]),
		]);

		expect(result.rejected).toEqual([]);
		expect(result.ops).toHaveLength(1);
		expect(result.ops[0]?.signer).toBe("indexer-node");
		expect(result.ops[0]?.authLevel).toBe("posting");
	});

	test("rejects custom_json with both authority arrays populated", () => {
		const result = parseHafAHOperations([
			makeCustomJsonOperation(ACTION_TRANSFER, ["alice"], ["alice"]),
		]);

		expect(result.ops).toEqual([]);
		expect(result.rejected[0]?.reason).toBe("Mixed authority levels: required_auths and required_posting_auths cannot both be non-empty");
	});

	test("rejects multi-account co-signed custom_json (single-account multisig still passes)", () => {
		const result = parseHafAHOperations([
			makeCustomJsonOperation(ACTION_TRANSFER, [], ["alice", "bob"]),
		]);

		expect(result.ops).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("Multi-account co-signed custom_json not supported");
		expect(result.rejected[0]?.reason).toContain("2 posting signers");
	});

	test("rejects malformed protocol versions instead of accepting NaN comparisons", () => {
		const result = parseHafAHOperations([
			makeCustomJsonOperation(ACTION_TRANSFER, [], ["alice"], "not-semver"),
		]);

		expect(result.ops).toEqual([]);
		expect(result.rejected[0]?.reason).toBe("Invalid version format: not-semver");
	});

	test("rejects well-formed op that predates genesis block", () => {
		const result = parseHafAHOperations([
			makeCustomJsonOperation(ACTION_TRANSFER, [], ["alice"], PROTOCOL_VERSION, PROTOCOL_GENESIS_BLOCK - 1),
		]);

		expect(result.ops).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("predates genesis");
	});

	test("strips __proto__ and constructor keys from payload data", () => {
		const malicious = {
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: ACTION_TRANSFER,
			data: {
				from: "alice",
				to: "bob",
				nftId: "nft_1",
				__proto__: { polluted: true },
				constructor: { prototype: { polluted: true } },
			},
		};
		const op: HafAHOperation = {
			op: {
				type: "custom_json",
				value: {
					id: PROTOCOL_ID,
					json: JSON.stringify(malicious),
					required_auths: [],
					required_posting_auths: ["alice"],
				},
			},
			block: POST_GENESIS_BLOCK,
			trx_id: TX_ID,
			timestamp: "2026-01-01T00:00:00",
			operation_id: "1",
			virtual_op: false,
		};
		const result = parseHafAHOperations([op]);

		expect(result.rejected).toEqual([]);
		expect(result.ops).toHaveLength(1);
		const data = result.ops[0]?.data ?? {};
		expect(Object.prototype.hasOwnProperty.call(data, "__proto__")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(data, "constructor")).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

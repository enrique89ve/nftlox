// The HafAH client (`hive-client.ts:187`) blind-casts its JSON response to
// `HafAHOperation[]`. If the upstream endpoint is compromised or returns a
// malformed page, primitive fields like `block` are not actually guaranteed
// to be numbers at runtime. The parser must enforce the contract.
//
// Without a guard, `hafOp.block` of type `string` slips past the genesis
// gate (`"not-a-number" < 100_000_000` is `false` under JS coercion), and
// the corrupted value lands in `ParsedOperation.blockNum`, which downstream
// reaches the DB cursor and `invalid_operations` table.

import { describe, expect, test } from "bun:test";
import {
	ACTION_TRANSFER,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	PROTOCOL_GENESIS_BLOCK,
} from "@/protocol/index.ts";
import { parseHafAHOperations } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";

const TX_ID = "a".repeat(40);
const POST_GENESIS_BLOCK = PROTOCOL_GENESIS_BLOCK + 1;

function makeOpWithBlock(block: unknown): HafAHOperation {
	const raw = {
		op: {
			type: "custom_json",
			value: {
				id: PROTOCOL_ID,
				json: JSON.stringify({
					protocol: PROTOCOL_ID,
					version: PROTOCOL_VERSION,
					action: ACTION_TRANSFER,
					data: { from: "alice", to: "bob", nftId: "nft_1" },
				}),
				required_auths: [],
				required_posting_auths: ["alice"],
			},
		},
		block,
		trx_id: TX_ID,
		timestamp: "2026-01-01T00:00:00",
		operation_id: "1",
		virtual_op: false,
	};
	return raw as unknown as HafAHOperation;
}

function makeOpWithoutEnvelope(): HafAHOperation {
	const raw = {
		block: POST_GENESIS_BLOCK,
		trx_id: TX_ID,
		timestamp: "2026-01-01T00:00:00",
		operation_id: "1",
		virtual_op: false,
	};
	return raw as unknown as HafAHOperation;
}

describe("parseHafAHOperations — block field guard", () => {
	test("does not emit ops whose block is a string", () => {
		const result = parseHafAHOperations([makeOpWithBlock("not-a-number")]);

		expect(result.ops).toEqual([]);
	});

	test("does not emit ops whose block is fractional", () => {
		const result = parseHafAHOperations([makeOpWithBlock(POST_GENESIS_BLOCK + 0.5)]);

		expect(result.ops).toEqual([]);
	});

	test("does not emit ops whose block is negative", () => {
		const result = parseHafAHOperations([makeOpWithBlock(-1)]);

		expect(result.ops).toEqual([]);
	});

	test("still emits ops with a valid integer block", () => {
		const result = parseHafAHOperations([makeOpWithBlock(POST_GENESIS_BLOCK)]);

		expect(result.ops).toHaveLength(1);
		expect(result.ops[0]?.blockNum).toBe(POST_GENESIS_BLOCK);
	});

	test("canonicalizes HAFAH timezone-less timestamps as UTC", () => {
		const result = parseHafAHOperations([makeOpWithBlock(POST_GENESIS_BLOCK)]);

		expect(result.ops[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");
	});

	test("throws before projecting protocol ops with invalid HAFAH timestamps", () => {
		const op = makeOpWithBlock(POST_GENESIS_BLOCK) as unknown as { timestamp: string };
		op.timestamp = "2026-02-30T00:00:00";

		expect(() => parseHafAHOperations([op as unknown as HafAHOperation]))
			.toThrow("Invalid HAFAH timestamp value");
	});

	test("drops malformed rows with valid block but missing op envelope", () => {
		const result = parseHafAHOperations([makeOpWithoutEnvelope()]);

		expect(result.ops).toEqual([]);
		expect(result.rejected).toEqual([]);
	});
});

// HafAH bigints above Number.MAX_SAFE_INTEGER (2^53 - 1) collapse onto the
// same JS double when serialized as JSON number, so two unrelated operations
// would share the same `operationId`. Downstream, the `confirmed_operations`
// replay gate in action-router.ts:215 keys on operationId — a collision would
// cause the second buy/transfer to be silently skipped during crash replay.
// The parser must refuse the unsafe range and force the consumer to either
// receive a numeric string or downgrade the endpoint.
function makeOpWithOperationId(operationId: unknown): HafAHOperation {
	const raw = {
		op: {
			type: "custom_json",
			value: {
				id: PROTOCOL_ID,
				json: JSON.stringify({
					protocol: PROTOCOL_ID,
					version: PROTOCOL_VERSION,
					action: ACTION_TRANSFER,
					data: { from: "alice", to: "bob", nftId: "nft_1" },
				}),
				required_auths: [],
				required_posting_auths: ["alice"],
			},
		},
		block: POST_GENESIS_BLOCK,
		trx_id: TX_ID,
		timestamp: "2026-01-01T00:00:00",
		operation_id: operationId,
		virtual_op: false,
	};
	return raw as unknown as HafAHOperation;
}

describe("parseHafAHOperations — operation_id safety guard", () => {
	test("accepts a numeric string and coerces it onto ParsedOperation as string", () => {
		const result = parseHafAHOperations([makeOpWithOperationId("4294967296000")]);

		expect(result.ops).toHaveLength(1);
		expect(result.ops[0]?.operationId).toBe("4294967296000");
		expect(typeof result.ops[0]?.operationId).toBe("string");
	});

	test("accepts a safe-integer number and string-coerces it on the parsed output", () => {
		const result = parseHafAHOperations([makeOpWithOperationId(4_294_967_296)]);

		expect(result.ops).toHaveLength(1);
		expect(result.ops[0]?.operationId).toBe("4294967296");
		expect(typeof result.ops[0]?.operationId).toBe("string");
	});

	test("rejects a number above Number.MAX_SAFE_INTEGER (collapsing bigint)", () => {
		// `Number.MAX_SAFE_INTEGER + 1` cannot be distinguished from
		// `Number.MAX_SAFE_INTEGER + 2` once parsed into a JS Number.
		const result = parseHafAHOperations([makeOpWithOperationId(Number.MAX_SAFE_INTEGER + 1)]);

		expect(result.ops).toEqual([]);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0]?.reason).toContain("Invalid operation ID format");
	});

	test("rejects the JSON-collision pair (9007199254740993 → 9007199254740992)", () => {
		// `JSON.parse('{"id":9007199254740993}')` returns `{id: 9007199254740992}`.
		// Both literal numbers compile to the same JS Number, so this fixture
		// represents the exact collision scenario that motivates the guard.
		const collided = JSON.parse('{"id":9007199254740993}').id;
		const result = parseHafAHOperations([makeOpWithOperationId(collided)]);

		expect(result.ops).toEqual([]);
		expect(result.rejected).toHaveLength(1);
	});

	test("rejects negative, fractional, and non-numeric operation_id", () => {
		const negative = parseHafAHOperations([makeOpWithOperationId(-1)]);
		const fractional = parseHafAHOperations([makeOpWithOperationId(1.5)]);
		const nonNumericString = parseHafAHOperations([makeOpWithOperationId("not-a-number")]);
		const nullValue = parseHafAHOperations([makeOpWithOperationId(null)]);

		expect(negative.ops).toEqual([]);
		expect(fractional.ops).toEqual([]);
		expect(nonNumericString.ops).toEqual([]);
		expect(nullValue.ops).toEqual([]);
	});
});

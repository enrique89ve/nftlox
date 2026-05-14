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

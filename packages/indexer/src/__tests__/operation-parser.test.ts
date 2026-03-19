import { describe, test, expect } from "bun:test";
import { parseBlockOperations } from "../scanner/operation-parser.ts";
import type { BlockData } from "../scanner/hive-client.ts";

function makeBlock(overrides: Partial<BlockData> = {}): BlockData {
	return {
		blockNum: 90000100,
		timestamp: "2024-01-01T00:00:00",
		transactions: [],
		...overrides,
	};
}

function makeCustomJsonOp(payload: object, id = "nftlox_testnet", auths: string[] = ["alice"]) {
	return {
		type: "custom_json_operation",
		value: {
			required_posting_auths: auths,
			required_auths: [] as string[],
			id,
			json: JSON.stringify(payload),
		},
	};
}

function makeTransferOp(from: string, to: string, memo: string) {
	return {
		type: "transfer_operation",
		value: {
			from,
			to,
			amount: { amount: "1", precision: 3, nai: "@@000000021" },
			memo,
		},
	};
}

const validPayload = {
	protocol: "nftlox_testnet",
	version: "0.2.1",
	action: "mint",
	data: { id: "seed_abc", collectionId: "col_123" },
};

describe("parseBlockOperations", () => {
	test("returns empty for block with no transactions", () => {
		const block = makeBlock();
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("returns empty for block with non-protocol operations", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [{
					type: "vote_operation",
					value: { voter: "alice", author: "bob", permlink: "test", weight: 10000 },
				}],
			}],
		});
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("parses valid custom_json operation", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx_mint_001",
				operations: [makeCustomJsonOp(validPayload)],
			}],
		});

		const ops = parseBlockOperations(block);
		expect(ops).toHaveLength(1);
		expect(ops[0]!.action).toBe("mint");
		expect(ops[0]!.signer).toBe("alice");
		expect(ops[0]!.txId).toBe("tx_mint_001");
		expect(ops[0]!.blockNum).toBe(90000100);
		expect(ops[0]!.data).toEqual(validPayload.data);
		expect(ops[0]!.pairedTransfer).toBeUndefined();
	});

	test("extracts signer from required_auths when posting_auths empty", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [{
					type: "custom_json_operation",
					value: {
						required_auths: ["bob"],
						required_posting_auths: [],
						id: "nftlox_testnet",
						json: JSON.stringify(validPayload),
					},
				}],
			}],
		});

		const ops = parseBlockOperations(block);
		expect(ops[0]!.signer).toBe("bob");
	});

	test("ignores wrong protocol ID", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [makeCustomJsonOp(validPayload, "some_other_protocol")],
			}],
		});
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("ignores version below minimum", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [makeCustomJsonOp({ ...validPayload, version: "0.1.0" })],
			}],
		});
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("ignores invalid action", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [makeCustomJsonOp({ ...validPayload, action: "hack_the_planet" })],
			}],
		});
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("ignores missing data field", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [makeCustomJsonOp({
					protocol: "nftlox_testnet",
					version: "0.2.1",
					action: "mint",
				})],
			}],
		});
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("ignores malformed JSON", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [{
					type: "custom_json_operation",
					value: {
						required_posting_auths: ["alice"],
						required_auths: [],
						id: "nftlox_testnet",
						json: "not valid json {{{",
					},
				}],
			}],
		});
		expect(parseBlockOperations(block)).toEqual([]);
	});

	test("detects paired atomic transfer", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx_atomic",
				operations: [
					makeTransferOp("alice", "bob", "nftlox:transfer:seed_abc:col_123:1:dna123"),
					makeCustomJsonOp({
						...validPayload,
						action: "transfer",
						data: { nftId: "seed_abc", from: "alice", to: "bob" },
					}),
				],
			}],
		});

		const ops = parseBlockOperations(block);
		expect(ops).toHaveLength(1);
		expect(ops[0]!.action).toBe("transfer");
		expect(ops[0]!.pairedTransfer).toBeDefined();
		expect(ops[0]!.pairedTransfer!.from).toBe("alice");
		expect(ops[0]!.pairedTransfer!.to).toBe("bob");
		expect(ops[0]!.pairedTransfer!.memo).toBe("nftlox:transfer:seed_abc:col_123:1:dna123");
	});

	test("does not pair transfer with non-nftlox memo", () => {
		const block = makeBlock({
			transactions: [{
				txId: "tx1",
				operations: [
					makeTransferOp("alice", "bob", "just a regular memo"),
					makeCustomJsonOp(validPayload),
				],
			}],
		});

		const ops = parseBlockOperations(block);
		expect(ops).toHaveLength(1);
		expect(ops[0]!.pairedTransfer).toBeUndefined();
	});

	test("handles multiple transactions in one block", () => {
		const block = makeBlock({
			transactions: [
				{
					txId: "tx1",
					operations: [makeCustomJsonOp({ ...validPayload, data: { id: "seed_1" } })],
				},
				{
					txId: "tx2",
					operations: [makeCustomJsonOp({
						...validPayload,
						action: "create_collection",
						data: { id: "col_1", name: "Test" },
					})],
				},
			],
		});

		const ops = parseBlockOperations(block);
		expect(ops).toHaveLength(2);
		expect(ops[0]!.action).toBe("mint");
		expect(ops[1]!.action).toBe("create_collection");
	});

	test("parses all valid actions", () => {
		const actions: string[] = [
			"create_collection", "mint", "transfer", "burn", "replicate",
			"distribute", "set_data", "list", "unlist", "buy",
			"offer", "accept_offer", "reject_offer",
		];

		for (const action of actions) {
			const block = makeBlock({
				transactions: [{
					txId: `tx_${action}`,
					operations: [makeCustomJsonOp({
						...validPayload,
						action,
						data: { id: "test" },
					})],
				}],
			});
			const ops = parseBlockOperations(block);
			expect(ops).toHaveLength(1);
			expect(ops[0]!.action as string).toBe(action);
		}
	});
});

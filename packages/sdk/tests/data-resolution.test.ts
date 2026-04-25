import { afterEach, describe, expect, test } from "bun:test";

import {
	ACTION_SET_DATA,
	computeDataHash,
	resolveMutableDataFromOperation,
	type HiveL1Config,
} from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const l1Config: HiveL1Config = {
	endpoints: ["https://hafah.test"],
	timeoutMs: 1_000,
};

describe("resolveMutableDataFromOperation", () => {
	test("resolves mutable data by operation id and verifies hash", async () => {
		const mutableData = { level: 7, xp: 1200 };
		const expectedHash = await computeDataHash(mutableData);

		globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			expect(url).toBe("https://hafah.test/hafah-api/operations/451882812111324178");

			return new Response(JSON.stringify({
				op: {
					type: "custom_json_operation",
					value: {
						id: "nftlox_testnet",
						json: JSON.stringify({
							protocol: "nftlox_testnet",
							version: "0.10.0",
							action: ACTION_SET_DATA,
							data: {
								nftId: "nft_1",
								nftDna: "iTESTDNA123",
								mutableData,
							},
						}),
						required_auths: [],
						required_posting_auths: ["alice"],
					},
				},
				block: 105212166,
				trx_id: "506be0e61ae4dbb504397d7fb6ba59dbbab7e02e",
				op_pos: 0,
				op_type_id: 18,
				timestamp: "2026-04-04T00:50:18",
				virtual_op: false,
				operation_id: "451882812111324178",
				trx_in_block: 3,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const resolved = await resolveMutableDataFromOperation({
			l1Config,
			operationId: "451882812111324178",
			expectedHash,
			expectedActions: [ACTION_SET_DATA],
		});

		expect(resolved.operationId).toBe("451882812111324178");
		expect(resolved.txId).toBe("506be0e61ae4dbb504397d7fb6ba59dbbab7e02e");
		expect(resolved.blockNum).toBe(105212166);
		expect(resolved.signer).toBe("alice");
		expect(resolved.mutableData).toEqual(mutableData);
		expect(resolved.hash).toBe(expectedHash);
	});

	test("rejects when the resolved hash does not match", async () => {
		globalThis.fetch = (async (): Promise<Response> => new Response(JSON.stringify({
			op: {
				type: "custom_json_operation",
				value: {
					id: "nftlox_testnet",
					json: JSON.stringify({
						protocol: "nftlox_testnet",
						version: "0.10.0",
						action: ACTION_SET_DATA,
						data: {
							nftId: "nft_1",
							nftDna: "iTESTDNA123",
							mutableData: { level: 3, xp: 100 },
						},
					}),
					required_auths: [],
					required_posting_auths: ["alice"],
				},
			},
			block: 105212166,
			trx_id: "506be0e61ae4dbb504397d7fb6ba59dbbab7e02e",
			timestamp: "2026-04-04T00:50:18",
			virtual_op: false,
			operation_id: "451882812111324178",
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		await expect(resolveMutableDataFromOperation({
			l1Config,
			operationId: "451882812111324178",
			expectedHash: "data_deadbeef",
			expectedActions: [ACTION_SET_DATA],
		})).rejects.toThrow("Mutable data hash mismatch");
	});

	test("rejects when the payload omits version", async () => {
		globalThis.fetch = (async (): Promise<Response> => new Response(JSON.stringify({
			op: {
				type: "custom_json_operation",
				value: {
					id: "nftlox_testnet",
					json: JSON.stringify({
						protocol: "nftlox_testnet",
						action: ACTION_SET_DATA,
						data: {
							nftId: "nft_1",
							nftDna: "iTESTDNA123",
							mutableData: { level: 3, xp: 100 },
						},
					}),
					required_auths: [],
					required_posting_auths: ["alice"],
				},
			},
			block: 105212166,
			trx_id: "506be0e61ae4dbb504397d7fb6ba59dbbab7e02e",
			timestamp: "2026-04-04T00:50:18",
			virtual_op: false,
			operation_id: "451882812111324178",
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		await expect(resolveMutableDataFromOperation({
			l1Config,
			operationId: "451882812111324178",
			expectedHash: "data_deadbeef",
			expectedActions: [ACTION_SET_DATA],
		})).rejects.toThrow("payload missing version");
	});
});

import { afterEach, describe, expect, test } from "bun:test";

import {
	ACTION_BUY,
	ACTION_TRANSFER,
	verifyNftOwnership,
	type HiveL1Config,
} from "../src/index";

const originalFetch = globalThis.fetch;

const l1Config: HiveL1Config = {
	endpoints: ["https://hafah.test"],
	timeoutMs: 1_000,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("verifyNftOwnership", () => {
	test("verifies current ownership from owner_operation_id without using history", async () => {
		const urls: string[] = [];

		globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);

			if (url === "https://indexer.test/api/nfts/nft_1/proof") {
				return new Response(JSON.stringify({
					id: "nft_1",
					owner: "bob",
					previous_owner: "alice",
					owner_operation_id: "451882812111324178",
					created_tx_id: "mint_tx_1",
					seed_id: null,
					instance_number: null,
					instance_dna: null,
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === "https://hafah.test/hafah-api/operations/451882812111324178") {
				return new Response(JSON.stringify({
					op: {
						type: "custom_json_operation",
						value: {
							id: "nftlox_testnet",
							json: JSON.stringify({
								protocol: "nftlox_testnet",
								version: "0.7.0",
								action: ACTION_TRANSFER,
								data: {
									nftId: "nft_1",
									from: "alice",
									to: "bob",
								},
							}),
							required_auths: [],
							required_posting_auths: ["alice"],
						},
					},
					block: 105212166,
					trx_id: "transfer_tx_1",
					timestamp: "2026-04-04T00:50:18",
					virtual_op: false,
					operation_id: "451882812111324178",
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		}) as unknown as typeof fetch;

		const result = await verifyNftOwnership({
			nftId: "nft_1",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		expect(result.status).toBe("verified");
		expect(result.reportedOwner).toBe("bob");
		expect(result.proofsChecked).toBe(1);
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0]?.eventType).toBe(ACTION_TRANSFER);
		expect(result.checks[0]?.operationId).toBe("451882812111324178");
		expect(result.checks[0]?.derivedOwner).toBe("bob");
		expect(result.checks[0]?.previousOwner).toBe("alice");
		expect(urls.some((url) => url.includes("/history"))).toBe(false);
	});

	test("verifies buy ownership using payment memos from the Hive transaction", async () => {
		globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);

			if (url === "https://indexer.test/api/nfts/nft_buy_1/proof") {
				return new Response(JSON.stringify({
					id: "nft_buy_1",
					owner: "bob",
					previous_owner: "alice",
					owner_operation_id: "451882812111324999",
					created_tx_id: "mint_tx_buy_1",
					seed_id: null,
					instance_number: null,
					instance_dna: null,
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === "https://hafah.test/hafah-api/operations/451882812111324999") {
				return new Response(JSON.stringify({
					op: {
						type: "custom_json_operation",
						value: {
							id: "nftlox_testnet",
							json: JSON.stringify({
								protocol: "nftlox_testnet",
								version: "0.7.0",
								action: ACTION_BUY,
								data: {
									nftId: "nft_buy_1",
									listingId: "list_1",
									listTxId: "list_tx_1",
									txId: "mint_tx_buy_1",
								},
							}),
							required_auths: ["node.signer"],
							required_posting_auths: [],
						},
					},
					block: 105212200,
					trx_id: "buy_tx_1",
					timestamp: "2026-04-04T01:02:18",
					virtual_op: false,
					operation_id: "451882812111324999",
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === "https://hafah.test/hafah-api/transactions/buy_tx_1") {
				return new Response(JSON.stringify({
					transaction_id: "buy_tx_1",
					block_num: 105212200,
					operations: [
						{
							type: "transfer_operation",
							value: {
								from: "bob",
								to: "alice",
								amount: "1.000 HIVE",
								memo: "NFTLox BUY:nft_buy_1",
							},
						},
						{
							type: "transfer_operation",
							value: {
								from: "bob",
								to: "node.signer",
								amount: "0.010 HIVE",
								memo: "NFTLox FEE:nft_buy_1",
							},
						},
						{
							type: "custom_json_operation",
							value: {
								id: "nftlox_testnet",
								json: "{}",
								required_auths: ["node.signer"],
								required_posting_auths: [],
							},
						},
					],
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		}) as unknown as typeof fetch;

		const result = await verifyNftOwnership({
			nftId: "nft_buy_1",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		expect(result.status).toBe("verified");
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0]?.eventType).toBe(ACTION_BUY);
		expect(result.checks[0]?.derivedOwner).toBe("bob");
		expect(result.checks[0]?.previousOwner).toBe("alice");
		expect(result.checks[0]?.expectedSigner).toBe("node.signer");
	});

	test("returns mismatch when indexer previous_owner contradicts the on-chain ownership edge", async () => {
		globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);

			if (url === "https://indexer.test/api/nfts/nft_2/proof") {
				return new Response(JSON.stringify({
					id: "nft_2",
					owner: "bob",
					previous_owner: "charlie",
					owner_operation_id: "451882812111325000",
					created_tx_id: "mint_tx_2",
					seed_id: null,
					instance_number: null,
					instance_dna: null,
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === "https://hafah.test/hafah-api/operations/451882812111325000") {
				return new Response(JSON.stringify({
					op: {
						type: "custom_json_operation",
						value: {
							id: "nftlox_testnet",
							json: JSON.stringify({
								protocol: "nftlox_testnet",
								version: "0.7.0",
								action: ACTION_TRANSFER,
								data: {
									nftId: "nft_2",
									from: "alice",
									to: "bob",
								},
							}),
							required_auths: [],
							required_posting_auths: ["alice"],
						},
					},
					block: 105212201,
					trx_id: "transfer_tx_2",
					timestamp: "2026-04-04T01:03:18",
					virtual_op: false,
					operation_id: "451882812111325000",
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		}) as unknown as typeof fetch;

		const result = await verifyNftOwnership({
			nftId: "nft_2",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		expect(result.status).toBe("mismatch");
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0]?.l1Status).toBe("mismatch");
		expect(result.message).toContain("previous_owner");
	});
});

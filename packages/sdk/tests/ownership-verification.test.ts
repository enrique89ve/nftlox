import { afterEach, describe, expect, test } from "bun:test";

import {
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
	ACTION_CREATE_COLLECTION,
	ACTION_LIST,
	ACTION_TRANSFER,
	calculatePaymentSplitFromUnits,
	generateDeterministicCollectionId,
	generateListingId,
	verifyNftOwnership,
	type HiveL1Config,
} from "../src/index";

// Format integer Hive units back to the canonical "X.XXX" wire string used
// in transfer mocks. Mirrors the unitsToCanonicalString helper inside the
// SPV verifier so tests share the same wire-format assumption.
function unitsToWire(units: number): string {
	const intPart = Math.floor(units / 1000);
	const decPart = units % 1000;
	return `${intPart}.${decPart.toString().padStart(3, "0")}`;
}

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
					nft_dna: null,
					collection_id: "col_test_1",
					collection_created_block_num: 105212100,
					collection_created_tx_id: "c".repeat(40),
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
								version: "0.10.0",
								action: ACTION_TRANSFER,
								data: {
									nftId: "nft_1",
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

	type BuyFlowOverrides = Readonly<{
		readonly commitmentOperationId?: string;
		readonly royaltyPct?: number;
		readonly royaltyRecipient?: string | null;
		// Override the seller to exercise self-royalty (seller === royaltyRecipient)
		// or the seller-is-settlement-node edge (seller === settlementNode).
		readonly seller?: string;
	}>;

	async function installBuyFlowMock(overrides: BuyFlowOverrides = {}): Promise<{
		readonly listingId: string;
		readonly collectionId: string;
		readonly seller: string;
		readonly transferCount: number;
	}> {
		const seller = overrides.seller ?? "alice";
		const settlementNode = "node.signer";
		const royaltyPct = overrides.royaltyPct ?? 0;
		const royaltyRecipient = overrides.royaltyRecipient ?? null;
		const listTxId = "d".repeat(40);
		const collectionTxId = "c".repeat(40);
		const collectionBlockNum = 105212100;
		const collectionName = "Buy Collection";
		const collectionSymbol = "BUY";
		const collectionId = await generateDeterministicCollectionId("creator", collectionName, collectionSymbol);
		const listingNonce = "nonce-buy-1";
		const listingExpiresAt = 1_800_000_000_000;
		const listingId = await generateListingId({
			nftId: "nft_buy_1",
			owner: seller,
			marketplace: "",
			priceAmount: "1.000",
			priceCurrency: "HIVE",
			expiresAt: listingExpiresAt,
			nonce: listingNonce,
		});
		const commitmentOperationId = overrides.commitmentOperationId ?? "451882812111324998";

		// Drive transfer emission via the protocol-codified split so every test
		// shape (no royalty, with royalty, self-royalty, seller-is-fee-account)
		// produces the exact wire amounts the verifier expects. Sums to 1.000.
		const split = calculatePaymentSplitFromUnits(
			1_000,
			royaltyPct,
			royaltyRecipient,
			seller,
			settlementNode,
		);
		type WireTransfer = { type: "transfer_operation"; value: Record<string, string> };
		const buyTransfers: WireTransfer[] = [
			{
				type: "transfer_operation",
				value: {
					from: "bob",
					to: seller,
					amount: `${unitsToWire(split.sellerUnits)} HIVE`,
					memo: `NFTLox BUY:nft_buy_1`,
				},
			},
		];
		if (split.royaltyUnits > 0 && split.effectiveRoyaltyRecipient !== null) {
			buyTransfers.push({
				type: "transfer_operation",
				value: {
					from: "bob",
					to: split.effectiveRoyaltyRecipient,
					amount: `${unitsToWire(split.royaltyUnits)} HIVE`,
					memo: `NFTLox ROY:nft_buy_1`,
				},
			});
		}
		if (split.feeUnits > 0) {
			buyTransfers.push({
				type: "transfer_operation",
				value: {
					from: "bob",
					to: settlementNode,
					amount: `${unitsToWire(split.feeUnits)} HIVE`,
					memo: `NFTLox FEE:nft_buy_1`,
				},
			});
		}
		const transferCount = buyTransfers.length;

		globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);

			if (url === "https://indexer.test/api/nfts/nft_buy_1/proof") {
				return new Response(JSON.stringify({
					id: "nft_buy_1",
					owner: "bob",
					previous_owner: seller,
					owner_operation_id: "451882812111324999",
					created_tx_id: "mint_tx_buy_1",
					seed_id: null,
					instance_number: null,
					nft_dna: null,
					collection_id: collectionId,
					collection_created_block_num: collectionBlockNum,
					collection_created_tx_id: collectionTxId,
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
								version: "0.10.0",
								action: ACTION_BUY,
								data: {
									nftId: "nft_buy_1",
									listingId,
									listTxId,
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

			if (url === `https://hafah.test/hafah-api/transactions/${collectionTxId}`) {
				return new Response(JSON.stringify({
					transaction_id: collectionTxId,
					block_num: collectionBlockNum,
					operations: [
						{
							type: "transfer_operation",
							value: {
								from: "creator",
								to: "node.signer",
								amount: "0.100 HBD",
								memo: `NFTLox FEE-COL:${collectionId}`,
							},
						},
						{
							type: "custom_json_operation",
							value: {
								id: "nftlox_testnet",
								json: JSON.stringify({
									protocol: "nftlox_testnet",
									version: "0.10.0",
									action: ACTION_CREATE_COLLECTION,
									data: {
										id: collectionId,
										name: collectionName,
										symbol: collectionSymbol,
										totalPotential: 0,
										maxInstances: 0,
										originDna: "0".repeat(40),
										metadata: { description: "Buy collection", image: "https://example.com/image.png" },
										rules: {
											transferable: true,
											burnable: true,
											royaltyPct,
											...(royaltyRecipient ? { royaltyRecipient } : {}),
										},
									},
								}),
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

			if (url === `https://hafah.test/hafah-api/transactions/${listTxId}`) {
				return new Response(JSON.stringify({
					transaction_id: listTxId,
					block_num: 105212180,
					operations: [
						{
							type: "custom_json_operation",
							value: {
								id: "nftlox_testnet",
								json: JSON.stringify({
									protocol: "nftlox_testnet",
									version: "0.10.0",
									action: ACTION_LIST,
									data: {
										nftId: "nft_buy_1",
										listingId,
										listingNonce,
										price: { amount: "1.000", currency: "HIVE" },
										expiresAt: listingExpiresAt,
									},
								}),
								required_auths: [],
								required_posting_auths: [seller],
							},
						},
					],
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
						...buyTransfers,
						{
							type: "custom_json_operation",
							value: {
								id: "nftlox_testnet",
								json: "{}",
								required_auths: [settlementNode],
								required_posting_auths: [],
							},
						},
					],
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (url === "https://hafah.test/hafah-api/operations?from-block=105212190&to-block=105212201&operation-types=18&page-size=1000&operation-begin=-1") {
				return new Response(JSON.stringify({
					ops: [
						{
							op: {
								type: "custom_json_operation",
								value: {
									id: "nftlox_testnet",
									json: JSON.stringify({
										protocol: "nftlox_testnet",
										version: "0.10.0",
										action: ACTION_BUY_COMMITMENT,
										data: {
											txHash: "buy_tx_1",
											nftId: "nft_buy_1",
											listingId,
											listTxId,
											buyer: "bob",
										},
									}),
									required_auths: ["node.signer"],
									required_posting_auths: [],
								},
							},
							block: 105212198,
							trx_id: "commit_tx_1",
							timestamp: "2026-04-04T01:01:48",
							virtual_op: false,
							operation_id: commitmentOperationId,
						},
					],
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		}) as unknown as typeof fetch;

		return { listingId, collectionId, seller, transferCount };
	}

	test("verifies buy ownership using payment memos from the Hive transaction", async () => {
		const { transferCount } = await installBuyFlowMock();

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
		// Sanity: default config (royaltyPct=0) emits 2 transfers (seller + fee).
		expect(transferCount).toBe(2);
	});

	// F2 optional-leg coverage: each branch of `calculatePaymentSplitFromUnits`
	// must drive a verifier-accepted on-chain transfer shape with no float
	// drift. Presence is decided by `units > 0`, never by tolerance.
	test("F2: verifies buy with explicit royalty leg (3 transfers: seller + royalty + fee)", async () => {
		const { transferCount } = await installBuyFlowMock({
			royaltyPct: 5,
			royaltyRecipient: "creator",
		});

		const result = await verifyNftOwnership({
			nftId: "nft_buy_1",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		expect(result.status).toBe("verified");
		expect(transferCount).toBe(3);
	});

	test("F2: self-royalty (recipient === seller) collapses to 2 transfers (no royalty leg)", async () => {
		const { transferCount } = await installBuyFlowMock({
			royaltyPct: 5,
			royaltyRecipient: "alice", // === default seller
		});

		const result = await verifyNftOwnership({
			nftId: "nft_buy_1",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		// `computeRoyalty` collapses self-royalty so the on-chain shape only
		// emits seller + fee. Verifier must accept exactly 2 transfers.
		expect(result.status).toBe("verified");
		expect(transferCount).toBe(2);
	});

	test("F2: seller === settlementNode collapses fee leg (2 transfers: seller + royalty)", async () => {
		const { transferCount } = await installBuyFlowMock({
			seller: "node.signer", // === settlementNode
			royaltyPct: 5,
			royaltyRecipient: "creator",
		});

		const result = await verifyNftOwnership({
			nftId: "nft_buy_1",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		expect(result.status).toBe("verified");
		// `feeAccount === seller` collapses fee leg; only seller + royalty emitted.
		expect(transferCount).toBe(2);
	});

	test("rejects buy when HAFAH commitment operation_id is not parseable as BigInt", async () => {
		// F4 guard: a HAFAH operation_id that BigInt() cannot parse means the
		// commitment-precedes-buy ordering is unenforceable. Verifier must
		// fail hard, not silently skip the operation, so a HAFAH format flip
		// surfaces as a verification regression instead of a silent accept.
		await installBuyFlowMock({ commitmentOperationId: "not-a-bigint" });

		const result = await verifyNftOwnership({
			nftId: "nft_buy_1",
			expectedOwner: "bob",
			indexerBaseUrl: "https://indexer.test",
			l1Config,
		});

		expect(result.status).toBe("mismatch");
		expect(result.message).toContain("not a parseable BigInt");
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
					nft_dna: null,
					collection_id: "col_test_2",
					collection_created_block_num: 105212100,
					collection_created_tx_id: "c".repeat(40),
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
								version: "0.10.0",
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

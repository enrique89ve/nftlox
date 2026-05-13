import { test, expect, describe } from "bun:test";

import {
	buildBuy,
	symbolSchema,
	priceSchema,
	createCollectionInputSchema,
	mintInputSchema,
	type HiveOperation,
	type HiveTransferOperation,
} from "../src/index";

// SDK-specific coverage. Protocol-level payload/DNA/auth tests live in
// packages/protocol/tests/. This file only tests the thin SDK layer:
// - Input schemas (Zod)
// - buildBuy's multi-operation transfer generation

describe("SDK input schemas", () => {
	describe("symbolSchema", () => {
		test("valid symbols pass", () => {
			expect(symbolSchema.safeParse("TEST").success).toBe(true);
			expect(symbolSchema.safeParse("ABC123").success).toBe(true);
			expect(symbolSchema.safeParse("XYZ").success).toBe(true);
		});

		test("invalid symbols fail", () => {
			expect(symbolSchema.safeParse("AB").success).toBe(false);
			expect(symbolSchema.safeParse("TOOLONGSYMBOL").success).toBe(false);
			expect(symbolSchema.safeParse("test!").success).toBe(false);
		});
	});

	describe("priceSchema", () => {
		test("valid prices pass", () => {
			expect(priceSchema.safeParse({ amount: "10.000", currency: "HIVE" }).success).toBe(true);
			expect(priceSchema.safeParse({ amount: "1.000", currency: "HBD" }).success).toBe(true);
		});

		test("invalid prices fail", () => {
			expect(priceSchema.safeParse({ amount: "0", currency: "HIVE" }).success).toBe(false);
			expect(priceSchema.safeParse({ amount: "10", currency: "BTC" as unknown as "HIVE" }).success).toBe(false);
		});
	});

	describe("createCollectionInputSchema", () => {
		const validInput = {
			name: "Test",
			symbol: "TEST",
			creator: "user",
			totalPotential: 100,
			maxInstances: 0,
			metadata: {
				description: "Test desc",
				image: "https://example.com/img.png",
			},
			rules: {
				transferable: true,
				burnable: true,
				royaltyPct: 5,
			},
		};

		test("valid input passes", () => {
			expect(createCollectionInputSchema.safeParse(validInput).success).toBe(true);
		});

		test("excessive royalty fails", () => {
			const invalid = {
				...validInput,
				rules: { ...validInput.rules, royaltyPct: 60 },
			};
			expect(createCollectionInputSchema.safeParse(invalid).success).toBe(false);
		});
	});

	describe("mintInputSchema", () => {
		const validInput = {
			collectionId: "col_test",
			edition: 1,
			owner: "user",
			name: "NFT #1",
			imageUrl: "https://example.com/nft.png",
			collectionBlock: 90000000,
		};

		test("valid input passes", () => {
			expect(mintInputSchema.safeParse(validInput).success).toBe(true);
		});

		test("invalid edition fails", () => {
			const invalid = { ...validInput, edition: 0 };
			expect(mintInputSchema.safeParse(invalid).success).toBe(false);
		});
	});
});

describe("buildBuy transfer generation", () => {
	const NFT_ID = "nft_buy_test_001";
	const LISTING_ID = "list_buy_test_001";
	const LIST_TX_ID = "b".repeat(40);
	const BUYER = "buyeraccount";
	const SELLER = "selleraccount";
	const FEE_ACCOUNT = "nftloxfees";
	const NFT_TX_ID = "c".repeat(40);

	const basePaymentSplit = {
		sellerAmount: 8.9,
		royaltyAmount: 0,
		royaltyRecipient: null,
		feeAmount: 0.1,
		feeAccount: FEE_ACCOUNT,
		totalPrice: 9,
		currency: "HIVE" as const,
	};

	const baseInput = {
		nftId: NFT_ID,
		listingId: LISTING_ID,
		listTxId: LIST_TX_ID,
		txId: NFT_TX_ID,
		buyer: BUYER,
		seller: SELLER,
		paymentSplit: basePaymentSplit,
	};

	test("generates seller + fee transfers when no royalty is present", () => {
		const result = buildBuy(baseInput);

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.operations;
		expect(ops).toHaveLength(3);
		expect(ops[0]![0]).toBe("transfer");
		expect(ops[1]![0]).toBe("transfer");
		expect(ops[2]![0]).toBe("custom_json");
	});

	test("generates seller + royalty + fee transfers (full split)", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 7.9,
				royaltyAmount: 1.0,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.1,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.operations;
		expect(ops).toHaveLength(4);

		const transferOps = ops.slice(0, -1);
		expect(transferOps.every((op) => op[0] === "transfer")).toBe(true);
		expect(ops[ops.length - 1]![0]).toBe("custom_json");
	});

	test("skips royalty transfer when royaltyAmount is 0", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 8.9,
				royaltyAmount: 0,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.1,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.operations;
		const transferMemos = ops
			.filter((op): op is HiveTransferOperation => op[0] === "transfer")
			.map((op) => op[1].memo);

		expect(transferMemos.some((m) => m?.includes("NFTLox ROY:"))).toBe(false);
		expect(ops).toHaveLength(3);
	});

		test("skips fee transfer when feeAmount is 0", () => {
			const result = buildBuy({
				...baseInput,
				paymentSplit: {
				sellerAmount: 9.0,
				royaltyAmount: 0,
				royaltyRecipient: null,
				feeAmount: 0,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.operations;
		const transferMemos = ops
			.filter((op): op is HiveTransferOperation => op[0] === "transfer")
			.map((op) => op[1].memo);

			expect(transferMemos.some((m) => m?.includes("NFTLox FEE:"))).toBe(false);
			expect(ops).toHaveLength(2);
		});

		test("rejects payment splits whose legs do not sum to totalPrice", () => {
			const result = buildBuy({
				...baseInput,
				paymentSplit: {
					sellerAmount: 0.001,
					royaltyAmount: 0,
					royaltyRecipient: null,
					feeAmount: 0,
					feeAccount: FEE_ACCOUNT,
					totalPrice: 100,
					currency: "HIVE",
				},
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.errors.some((error) => error.code === "INVALID_PAYMENT_SPLIT")).toBe(true);
		});

		test("rejects royalty amount without a royalty recipient", () => {
			const result = buildBuy({
				...baseInput,
				paymentSplit: {
					sellerAmount: 8,
					royaltyAmount: 1,
					royaltyRecipient: null,
					feeAmount: 0,
					feeAccount: FEE_ACCOUNT,
					totalPrice: 9,
					currency: "HIVE",
				},
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.errors[0]?.field).toBe("paymentSplit.royaltyRecipient");
		});

		test("transfer memos use correct NFTLox BUY/ROY/FEE prefixes", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 7.9,
				royaltyAmount: 1.0,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.1,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.operations;
		const transfers = ops.filter((op): op is HiveTransferOperation => op[0] === "transfer");

		expect(transfers[0]![1].memo).toBe(`NFTLox BUY:${NFT_ID}`);
		expect(transfers[0]![1].to).toBe(SELLER);

		expect(transfers[1]![1].memo).toBe(`NFTLox ROY:${NFT_ID}`);
		expect(transfers[1]![1].to).toBe("royaltyuser");

		expect(transfers[2]![1].memo).toBe(`NFTLox FEE:${NFT_ID}`);
		expect(transfers[2]![1].to).toBe(FEE_ACCOUNT);
	});

	test("all transfers come from buyer", () => {
		const result = buildBuy({
			...baseInput,
			paymentSplit: {
				sellerAmount: 7.9,
				royaltyAmount: 0.5,
				royaltyRecipient: "royaltyuser",
				feeAmount: 0.6,
				feeAccount: FEE_ACCOUNT,
				totalPrice: 9,
				currency: "HIVE",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const ops = result.operations;
		const transfers = ops.filter((op): op is HiveTransferOperation => op[0] === "transfer");

		expect(transfers.length).toBeGreaterThan(0);
		for (const transfer of transfers) {
			expect(transfer[1].from).toBe(BUYER);
		}
	});

	test("buy custom_json is node-signed with active auth", () => {
		const result = buildBuy(baseInput);
		expect(result.success).toBe(true);
		if (!result.success) return;

		const customJson = result.operations.find(
			(op): op is HiveOperation => op[0] === "custom_json",
		);
		expect(customJson).toBeDefined();
		expect(customJson![1].required_auths).toEqual([FEE_ACCOUNT]);
		expect(customJson![1].required_posting_auths).toEqual([]);
		expect(result.keyType).toBe("Active");
		expect(result.signer).toBe(BUYER);
		expect(result.coSigners).toEqual([{
			op: 2,
			account: FEE_ACCOUNT,
			keyType: "Active",
			via: "multisig",
		}]);
	});
});

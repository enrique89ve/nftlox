import { describe, expect, test } from "bun:test";
import { verifyTransfers } from "@/utils/validation.ts";

describe("verifyTransfers return shape", () => {
	test("returns split + buyerFromTransfer + consumedIndices", () => {
		// 1.00 HIVE total, 0% royalty, 1% protocol fee (100 bps) → seller gets 0.99, fee 0.01
		const transfers = [
			{ from: "buyer", to: "seller", amount: 0.99, currency: "HIVE", memo: "NFTLox BUY:inst_x" },
			{ from: "buyer", to: "nftlox", amount: 0.01, currency: "HIVE", memo: "NFTLox FEE:inst_x" },
		];
		const result = verifyTransfers({
			transfers,
			seller: "seller",
			totalPrice: 1.0,
			currency: "HIVE",
			royaltyPct: 0,
			royaltyRecipient: null,
			feeAccount: "nftlox",
			nftId: "inst_x",
			consumedIndices: new Set<number>(),
		});
		expect(result.split.sellerAmount).toBeCloseTo(0.99, 3);
		expect(result.buyerFromTransfer).toBe("buyer");
		expect(result.consumedIndices.length).toBe(2);
		expect(result.consumedIndices).toContain(0);
		expect(result.consumedIndices).toContain(1);
	});
});

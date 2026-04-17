import { describe, test, expect } from "bun:test";
import { calculatePaymentSplit, roundHive } from "../src/index.ts";

describe("payment split", () => {
	test("basic sale: 1% fee, 5% royalty", () => {
		const split = calculatePaymentSplit(100, "HIVE", 5, "royaltyacct", "seller123", "nftlox");
		expect(split.feeAmount).toBe(1);
		expect(split.royaltyAmount).toBe(5);
		expect(split.sellerAmount).toBe(94);
	});

	test("royalty merges into seller when recipient === seller", () => {
		const split = calculatePaymentSplit(100, "HIVE", 5, "seller123", "seller123", "nftlox");
		expect(split.royaltyAmount).toBe(0);
		expect(split.royaltyRecipient).toBeNull();
		expect(split.sellerAmount).toBe(99);
	});

	test("fee merges when feeAccount === seller", () => {
		const split = calculatePaymentSplit(100, "HIVE", 0, null, "seller123", "seller123");
		expect(split.feeAmount).toBe(0);
		expect(split.sellerAmount).toBe(100);
	});

	test("rejects royaltyPct > 50", () => {
		expect(() => calculatePaymentSplit(100, "HIVE", 51, "royalty", "seller", "fee")).toThrow();
	});

	test("roundHive rounds to 3 decimals", () => {
		expect(roundHive(1.2345)).toBe(1.235);
		expect(roundHive(1.0004)).toBe(1);
	});
});

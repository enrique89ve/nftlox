import { describe, test, expect } from "bun:test";
import { calculatePaymentSplit, MIN_PRICE_AMOUNT, roundHive } from "../src/index.ts";

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

	test("fractional split uses exact millihive units and sums to total", () => {
		const split = calculatePaymentSplit(3.333, "HIVE", 7, "royaltyacct", "seller123", "nftlox");
		expect(split.feeAmount).toBe(0.033);
		expect(split.royaltyAmount).toBe(0.233);
		expect(split.sellerAmount).toBe(3.067);
		expect(roundHive(split.sellerAmount + split.royaltyAmount + split.feeAmount)).toBe(split.totalPrice);
	});

	test("rejects invalid numeric inputs before producing a split", () => {
		expect(() => calculatePaymentSplit(Number.NaN, "HIVE", 0, null, "seller", "fee")).toThrow(/totalPrice/);
		expect(() => calculatePaymentSplit(1, "HIVE", Number.NaN, null, "seller", "fee")).toThrow(/royaltyPct/);
		expect(() => calculatePaymentSplit(1.0004, "HIVE", 0, null, "seller", "fee")).toThrow(/3 decimal/);
	});

	test("enforces the canonical minimum listing price", () => {
		expect(() => calculatePaymentSplit(0.099, "HIVE", 0, null, "seller", "fee")).toThrow(MIN_PRICE_AMOUNT);
		expect(calculatePaymentSplit(Number(MIN_PRICE_AMOUNT), "HIVE", 0, null, "seller", "fee").totalPrice).toBe(0.1);
	});
});

import { describe, test, expect } from "bun:test";
import {
	calculatePaymentSplit,
	calculatePaymentSplitFromUnits,
	MIN_PRICE_AMOUNT,
	roundHive,
} from "../src/index.ts";

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

// Frozen vectors for `calculatePaymentSplitFromUnits` — the integer-units
// primitive every consumer (SDK builder, indexer handler, SPV verifier) must
// agree on. Each optional-leg branch is pinned: presence is decided strictly
// by `units > 0`, never by a float tolerance.
describe("calculatePaymentSplitFromUnits (frozen optional-leg vectors)", () => {
	test("happy path: 5% royalty + 1% fee + distinct seller", () => {
		const split = calculatePaymentSplitFromUnits(100_000, 5, "royaltyacct", "seller123", "nftlox");
		expect(split).toEqual({
			sellerUnits: 94_000,
			royaltyUnits: 5_000,
			effectiveRoyaltyRecipient: "royaltyacct",
			feeUnits: 1_000,
			totalUnits: 100_000,
		});
		expect(split.sellerUnits + split.royaltyUnits + split.feeUnits).toBe(split.totalUnits);
	});

	test("no royalty: royaltyPct === 0 collapses royalty leg into seller", () => {
		const split = calculatePaymentSplitFromUnits(100_000, 0, "royaltyacct", "seller123", "nftlox");
		expect(split.royaltyUnits).toBe(0);
		expect(split.effectiveRoyaltyRecipient).toBeNull();
		expect(split.feeUnits).toBe(1_000);
		expect(split.sellerUnits).toBe(99_000);
	});

	test("no royalty: royaltyRecipient === null collapses royalty leg into seller", () => {
		const split = calculatePaymentSplitFromUnits(100_000, 5, null, "seller123", "nftlox");
		expect(split.royaltyUnits).toBe(0);
		expect(split.effectiveRoyaltyRecipient).toBeNull();
		expect(split.sellerUnits).toBe(99_000);
	});

	test("self-royalty: royaltyRecipient === seller collapses royalty into seller", () => {
		const split = calculatePaymentSplitFromUnits(100_000, 5, "seller123", "seller123", "nftlox");
		expect(split.royaltyUnits).toBe(0);
		expect(split.effectiveRoyaltyRecipient).toBeNull();
		expect(split.sellerUnits).toBe(99_000);
		expect(split.feeUnits).toBe(1_000);
	});

	test("seller IS feeAccount: feeUnits === 0 (no fee leg)", () => {
		const split = calculatePaymentSplitFromUnits(100_000, 5, "royaltyacct", "seller123", "seller123");
		expect(split.feeUnits).toBe(0);
		expect(split.royaltyUnits).toBe(5_000);
		expect(split.sellerUnits).toBe(95_000);
	});

	test("seller IS feeAccount AND self-royalty: only seller leg (no fee, no royalty)", () => {
		const split = calculatePaymentSplitFromUnits(100_000, 5, "seller123", "seller123", "seller123");
		expect(split.feeUnits).toBe(0);
		expect(split.royaltyUnits).toBe(0);
		expect(split.effectiveRoyaltyRecipient).toBeNull();
		expect(split.sellerUnits).toBe(100_000);
	});

	test("fractional split sums to totalUnits exactly (no float drift)", () => {
		const split = calculatePaymentSplitFromUnits(3_333, 7, "royaltyacct", "seller123", "nftlox");
		expect(split.feeUnits).toBe(33);
		expect(split.royaltyUnits).toBe(233);
		expect(split.sellerUnits).toBe(3_067);
		expect(split.sellerUnits + split.royaltyUnits + split.feeUnits).toBe(split.totalUnits);
	});

	test("rejects non-safe-integer totalUnits", () => {
		expect(() => calculatePaymentSplitFromUnits(1.5, 0, null, "s", "f")).toThrow(/safe integer/);
		expect(() => calculatePaymentSplitFromUnits(Number.NaN, 0, null, "s", "f")).toThrow(/safe integer/);
	});
});

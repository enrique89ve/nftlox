import { test, expect, describe } from "bun:test";

import {
	calculatePaymentSplit,
	PROTOCOL_FEE_BPS,
	BASIS_POINTS_DENOMINATOR,
	calculateBasisPointsAmount,
	percentageToBasisPoints,
	roundHive,
	type PaymentSplit,
} from "../src/index";

// ============ TEST FIXTURES ============

const SELLER = "seller";
const NODE = "node";
const ROYALTY_RECIPIENT = "artist";
const HIVE = "HIVE";
const HBD = "HBD";

const DEFAULT_PRICE = 100;
const DEFAULT_ROYALTY_PCT = 10;

// ============ HELPER ============

const assertSumsToTotal = (split: Readonly<PaymentSplit>): void => {
	const sum = roundHive(
		split.sellerAmount
		+ split.royaltyAmount
		+ split.feeAmount,
	);
	expect(sum).toBe(split.totalPrice);
};

// ============ TESTS ============

describe("calculatePaymentSplit", () => {

	describe("constants sanity check", () => {
		test("PROTOCOL_FEE_BPS should be 100 (1%)", () => {
			expect(PROTOCOL_FEE_BPS).toBe(100);
			expect(calculateBasisPointsAmount(100, PROTOCOL_FEE_BPS)).toBe(1.0);
		});

		test("percentageToBasisPoints should convert percent to bps", () => {
			expect(BASIS_POINTS_DENOMINATOR).toBe(10_000);
			expect(percentageToBasisPoints(1)).toBe(100);
			expect(percentageToBasisPoints(2.5)).toBe(250);
		});
	});

	describe("roundHive", () => {
		test("should round to 3 decimal places", () => {
			expect(roundHive(1.2345)).toBe(1.235);
			expect(roundHive(1.2344)).toBe(1.234);
			expect(roundHive(0.0005)).toBe(0.001);
			expect(roundHive(0.0004)).toBe(0);
		});
	});

	describe("basic split - no royalty", () => {
		const split = calculatePaymentSplit(
			DEFAULT_PRICE, HIVE, 0, null, SELLER, NODE,
		);

		test("feeAmount should be 1.0 (1% protocol fee)", () => {
			expect(split.feeAmount).toBe(1.0);
		});

		test("feeAccount should be the node", () => {
			expect(split.feeAccount).toBe(NODE);
		});

		test("sellerAmount should be 99.0", () => {
			expect(split.sellerAmount).toBe(99.0);
		});

		test("royaltyAmount should be 0", () => {
			expect(split.royaltyAmount).toBe(0);
		});

		test("royaltyRecipient should be null", () => {
			expect(split.royaltyRecipient).toBeNull();
		});

		test("amounts should sum to totalPrice", () => {
			assertSumsToTotal(split);
		});
	});

	describe("with royalty", () => {
		const split = calculatePaymentSplit(
			DEFAULT_PRICE, HIVE, DEFAULT_ROYALTY_PCT, ROYALTY_RECIPIENT, SELLER, NODE,
		);

		test("royaltyAmount should be 10.0", () => {
			expect(split.royaltyAmount).toBe(10.0);
		});

		test("royaltyRecipient should be the artist", () => {
			expect(split.royaltyRecipient).toBe(ROYALTY_RECIPIENT);
		});

		test("feeAmount should be 1.0", () => {
			expect(split.feeAmount).toBe(1.0);
		});

		test("sellerAmount should be 89.0", () => {
			expect(split.sellerAmount).toBe(89.0);
		});

		test("amounts should sum to totalPrice", () => {
			assertSumsToTotal(split);
		});
	});

	describe("with royaltyRecipient === seller", () => {
		const split = calculatePaymentSplit(
			DEFAULT_PRICE, HIVE, DEFAULT_ROYALTY_PCT, SELLER, SELLER, NODE,
		);

		test("royaltyAmount should be 0 (merged into seller)", () => {
			expect(split.royaltyAmount).toBe(0);
		});

		test("royaltyRecipient should be null", () => {
			expect(split.royaltyRecipient).toBeNull();
		});

		test("sellerAmount should be 99.0 (gets royalty implicitly)", () => {
			expect(split.sellerAmount).toBe(99.0);
		});

		test("amounts should sum to totalPrice", () => {
			assertSumsToTotal(split);
		});
	});

	describe("with feeAccount === seller", () => {
		const split = calculatePaymentSplit(
			DEFAULT_PRICE, HIVE, 0, null, SELLER, SELLER,
		);

		test("feeAmount should be 0 (merged into seller)", () => {
			expect(split.feeAmount).toBe(0);
		});

		test("sellerAmount should be 100.0", () => {
			expect(split.sellerAmount).toBe(100.0);
		});

		test("amounts should sum to totalPrice", () => {
			assertSumsToTotal(split);
		});
	});

	describe("amounts sum to totalPrice for all scenarios", () => {
		test("no royalty", () => {
			assertSumsToTotal(calculatePaymentSplit(100, HIVE, 0, null, SELLER, NODE));
		});

		test("with royalty", () => {
			assertSumsToTotal(calculatePaymentSplit(100, HIVE, 10, ROYALTY_RECIPIENT, SELLER, NODE));
		});

		test("royaltyRecipient === seller", () => {
			assertSumsToTotal(calculatePaymentSplit(100, HIVE, 10, SELLER, SELLER, NODE));
		});

		test("large price (999999.999 HIVE)", () => {
			assertSumsToTotal(calculatePaymentSplit(999999.999, HIVE, 5, ROYALTY_RECIPIENT, SELLER, NODE));
		});

		test("fractional price (3.333 HIVE)", () => {
			assertSumsToTotal(calculatePaymentSplit(3.333, HIVE, 7, ROYALTY_RECIPIENT, SELLER, NODE));
		});
	});

	describe("HBD currency pass-through", () => {
		const split = calculatePaymentSplit(50, HBD, 5, ROYALTY_RECIPIENT, SELLER, NODE);

		test("currency should be HBD", () => {
			expect(split.currency).toBe(HBD);
		});

		test("totalPrice should be preserved", () => {
			expect(split.totalPrice).toBe(50);
		});

		test("amounts should sum to totalPrice", () => {
			assertSumsToTotal(split);
		});
	});

	describe("small price (0.001 HIVE) - rounding edge case", () => {
		const split = calculatePaymentSplit(0.001, HIVE, 10, ROYALTY_RECIPIENT, SELLER, NODE);

		test("sellerAmount should not be negative", () => {
			expect(split.sellerAmount).toBeGreaterThanOrEqual(0);
		});

		test("all amounts should be non-negative", () => {
			expect(split.feeAmount).toBeGreaterThanOrEqual(0);
			expect(split.royaltyAmount).toBeGreaterThanOrEqual(0);
		});
	});

	describe("feeAccount is always preserved", () => {
		test("uses provided feeAccount", () => {
			const split = calculatePaymentSplit(100, HIVE, 0, null, SELLER, NODE);
			expect(split.feeAccount).toBe(NODE);
		});

		test("with custom node name", () => {
			const split = calculatePaymentSplit(100, HIVE, 0, null, SELLER, "my-custom-node");
			expect(split.feeAccount).toBe("my-custom-node");
		});
	});

	describe("royalty edge cases", () => {
		test("royaltyPct > 0 but royaltyRecipient is null should yield no royalty", () => {
			const split = calculatePaymentSplit(100, HIVE, 10, null, SELLER, NODE);
			expect(split.royaltyAmount).toBe(0);
			expect(split.royaltyRecipient).toBeNull();
		});

		test("royaltyPct === 0 with a recipient should yield no royalty", () => {
			const split = calculatePaymentSplit(100, HIVE, 0, ROYALTY_RECIPIENT, SELLER, NODE);
			expect(split.royaltyAmount).toBe(0);
			expect(split.royaltyRecipient).toBeNull();
		});

		test("high royalty (50%) should leave seller with minimal amount", () => {
			const split = calculatePaymentSplit(100, HIVE, 50, ROYALTY_RECIPIENT, SELLER, NODE);
			expect(split.royaltyAmount).toBe(50);
			expect(split.sellerAmount).toBe(49.0);
			assertSumsToTotal(split);
		});
	});

	describe("output shape", () => {
		const split = calculatePaymentSplit(
			DEFAULT_PRICE, HIVE, DEFAULT_ROYALTY_PCT, ROYALTY_RECIPIENT, SELLER, NODE,
		);

		test("should contain all expected keys", () => {
			expect(split).toHaveProperty("sellerAmount");
			expect(split).toHaveProperty("royaltyAmount");
			expect(split).toHaveProperty("royaltyRecipient");
			expect(split).toHaveProperty("feeAmount");
			expect(split).toHaveProperty("feeAccount");
			expect(split).toHaveProperty("totalPrice");
			expect(split).toHaveProperty("currency");
		});

		test("totalPrice should match input", () => {
			expect(split.totalPrice).toBe(DEFAULT_PRICE);
		});

		test("currency should match input", () => {
			expect(split.currency).toBe(HIVE);
		});
	});
});

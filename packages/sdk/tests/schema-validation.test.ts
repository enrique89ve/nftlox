import { test, expect, describe } from "bun:test";
import { priceSchema, txIdSchema, listInputSchema } from "../src/schemas";

// ============ priceSchema ============

describe("priceSchema", () => {
	describe("valid amounts", () => {
		test("minimum amount 0.001 HIVE", () => {
			const result = priceSchema.safeParse({ amount: "0.001", currency: "HIVE" });
			expect(result.success).toBe(true);
		});

		test("1.000 HIVE", () => {
			const result = priceSchema.safeParse({ amount: "1.000", currency: "HIVE" });
			expect(result.success).toBe(true);
		});

		test("10.500 HBD", () => {
			const result = priceSchema.safeParse({ amount: "10.500", currency: "HBD" });
			expect(result.success).toBe(true);
		});

		test("large amount 999999.000 HIVE", () => {
			const result = priceSchema.safeParse({ amount: "999999.000", currency: "HIVE" });
			expect(result.success).toBe(true);
		});

		test("0.100 HBD", () => {
			const result = priceSchema.safeParse({ amount: "0.100", currency: "HBD" });
			expect(result.success).toBe(true);
		});
	});

	describe("invalid amounts", () => {
		test("rejects leading zeros: 001.000", () => {
			const result = priceSchema.safeParse({ amount: "001.000", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects 2 decimal places: 1.00", () => {
			const result = priceSchema.safeParse({ amount: "1.00", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects 4 decimal places: 1.0000", () => {
			const result = priceSchema.safeParse({ amount: "1.0000", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects no decimal places: 1", () => {
			const result = priceSchema.safeParse({ amount: "1", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects scientific notation: 1e3", () => {
			const result = priceSchema.safeParse({ amount: "1e3", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects negative amount: -1.000", () => {
			const result = priceSchema.safeParse({ amount: "-1.000", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects below minimum: 0.000", () => {
			const result = priceSchema.safeParse({ amount: "0.000", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects empty string amount", () => {
			const result = priceSchema.safeParse({ amount: "", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects non-numeric amount: abc", () => {
			const result = priceSchema.safeParse({ amount: "abc", currency: "HIVE" });
			expect(result.success).toBe(false);
		});

		test("rejects missing integer part: .001", () => {
			const result = priceSchema.safeParse({ amount: ".001", currency: "HIVE" });
			expect(result.success).toBe(false);
		});
	});

	describe("invalid currency", () => {
		test("rejects unsupported currency: VESTS", () => {
			const result = priceSchema.safeParse({ amount: "1.000", currency: "VESTS" });
			expect(result.success).toBe(false);
		});

		test("rejects non-Hive currency: USD", () => {
			const result = priceSchema.safeParse({ amount: "1.000", currency: "USD" });
			expect(result.success).toBe(false);
		});

		test("rejects empty currency", () => {
			const result = priceSchema.safeParse({ amount: "1.000", currency: "" });
			expect(result.success).toBe(false);
		});
	});
});

// ============ txIdSchema ============

describe("txIdSchema", () => {
	describe("valid transaction IDs", () => {
		test("40 lowercase hex chars", () => {
			const result = txIdSchema.safeParse("a0b1c2d3e4f5a6b7c8d9a0b1c2d3e4f5a6b7c8d9");
			expect(result.success).toBe(true);
		});

		test("all zeros", () => {
			const result = txIdSchema.safeParse("0000000000000000000000000000000000000000");
			expect(result.success).toBe(true);
		});

		test("all f's", () => {
			const result = txIdSchema.safeParse("ffffffffffffffffffffffffffffffffffffffff");
			expect(result.success).toBe(true);
		});
	});

	describe("invalid transaction IDs", () => {
		test("rejects too short (12 chars)", () => {
			const result = txIdSchema.safeParse("a0b1c2d3e4f5");
			expect(result.success).toBe(false);
		});

		test("rejects too long (41 chars)", () => {
			const result = txIdSchema.safeParse("a0b1c2d3e4f5a6b7c8d9a0b1c2d3e4f5a6b7c8d9a");
			expect(result.success).toBe(false);
		});

		test("rejects non-hex character g", () => {
			const result = txIdSchema.safeParse("g0b1c2d3e4f5a6b7c8d9a0b1c2d3e4f5a6b7c8d9");
			expect(result.success).toBe(false);
		});

		test("rejects uppercase hex", () => {
			const result = txIdSchema.safeParse("A0B1C2D3E4F5A6B7C8D9A0B1C2D3E4F5A6B7C8D9");
			expect(result.success).toBe(false);
		});

		test("rejects empty string", () => {
			const result = txIdSchema.safeParse("");
			expect(result.success).toBe(false);
		});
	});
});

// ============ listInputSchema.expiresAt ============

describe("listInputSchema expiresAt", () => {
	const validBaseInput = {
		nftId: "nft_abc123",
		price: { amount: "1.000", currency: "HIVE" as const },
	};

	test("accepts a timestamp in the future", () => {
		const futureTimestamp = Date.now() + 60_000;
		const result = listInputSchema.safeParse({
			...validBaseInput,
			expiresAt: futureTimestamp,
		});
		expect(result.success).toBe(true);
	});

	test("rejects a timestamp in the past", () => {
		const pastTimestamp = Date.now() - 60_000;
		const result = listInputSchema.safeParse({
			...validBaseInput,
			expiresAt: pastTimestamp,
		});
		expect(result.success).toBe(false);
	});

	test("expiresAt is evaluated at parse time, not at module load time", async () => {
		// First parse: a timestamp slightly in the future should pass
		const nearFuture = Date.now() + 2_000;
		const result1 = listInputSchema.safeParse({
			...validBaseInput,
			expiresAt: nearFuture,
		});
		expect(result1.success).toBe(true);

		// Wait so that the same timestamp is now in the past
		await new Promise((resolve) => setTimeout(resolve, 2_500));

		// Second parse: the same timestamp should now fail because
		// Date.now() is re-evaluated at parse time
		const result2 = listInputSchema.safeParse({
			...validBaseInput,
			expiresAt: nearFuture,
		});
		expect(result2.success).toBe(false);
	});

	test("accepts listing without expiresAt (optional)", () => {
		const result = listInputSchema.safeParse(validBaseInput);
		expect(result.success).toBe(true);
	});
});

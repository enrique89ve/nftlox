import { test, expect, describe } from "bun:test";
import { buildTransfer, buildList } from "../src/builders";

describe("Builder username validation", () => {
	describe("buildTransfer rejects invalid Hive usernames", () => {
		test("rejects segment too short (a.b)", async () => {
			const result = await buildTransfer({
				nftId: "nft_test123",
				from: "a.b",
				to: "alice",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const errorFields = result.errors.map((e) => e.field);
				expect(errorFields).toContain("from");
			}
		});

		test("rejects trailing dot (abc.)", async () => {
			const result = await buildTransfer({
				nftId: "nft_test123",
				from: "abc.",
				to: "alice",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const errorFields = result.errors.map((e) => e.field);
				expect(errorFields).toContain("from");
			}
		});

		test("rejects uppercase letters (ABC)", async () => {
			const result = await buildTransfer({
				nftId: "nft_test123",
				from: "ABC",
				to: "alice",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const errorFields = result.errors.map((e) => e.field);
				expect(errorFields).toContain("from");
			}
		});

		test("valid usernames do not produce username errors", async () => {
			const result = await buildTransfer({
				nftId: "nft_test123",
				from: "alice",
				to: "bob123",
			});

			if (!result.success) {
				const usernameErrors = result.errors.filter(
					(e) => e.field === "from" || e.field === "to",
				);
				expect(usernameErrors.length).toBe(0);
			}
		});
	});
});

describe("Builder price validation", () => {
	describe("buildList normalizes price formats", () => {
		test("normalizes 2 decimal places (1.00 → 1.000)", async () => {
			const result = await buildList({
				nftId: "nft_test123",
				price: { amount: "1.00", currency: "HIVE" },
				owner: "alice",
			});
			expect(result.success).toBe(true);
		});

		test("normalizes leading zeros (001.000 → 1.000)", async () => {
			const result = await buildList({
				nftId: "nft_test123",
				price: { amount: "001.000", currency: "HIVE" },
				owner: "alice",
			});
			expect(result.success).toBe(true);
		});

		test("valid price (1.000) does not produce price errors", async () => {
			const result = await buildList({
				nftId: "nft_test123",
				price: { amount: "1.000", currency: "HIVE" },
				owner: "alice",
			});

			if (!result.success) {
				const priceErrors = result.errors.filter(
					(e) => e.field.startsWith("price"),
				);
				expect(priceErrors.length).toBe(0);
			}
		});
	});
});

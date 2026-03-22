import { test, expect, describe } from "bun:test";
import { buildTransfer, buildList, buildPackTransfer } from "../src/builders";

describe("Builder username validation", () => {
	describe("buildTransfer rejects invalid Hive usernames", () => {
		test("rejects segment too short (a.b)", () => {
			const result = buildTransfer({
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

		test("rejects trailing dot (abc.)", () => {
			const result = buildTransfer({
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

		test("rejects uppercase letters (ABC)", () => {
			const result = buildTransfer({
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

		test("valid usernames do not produce username errors", () => {
			const result = buildTransfer({
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
	describe("buildList rejects invalid price formats", () => {
		test("rejects 2 decimal places (1.00)", () => {
			const result = buildList({
				nftId: "nft_test123",
				price: { amount: "1.00", currency: "HIVE" },
				owner: "alice",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const errorMessages = result.errors.map((e) => e.message);
				const hasPriceError = errorMessages.some((msg) =>
					msg.toLowerCase().includes("price") || msg.toLowerCase().includes("decimal"),
				);
				expect(hasPriceError).toBe(true);
			}
		});

		test("rejects leading zeros (001.000)", () => {
			const result = buildList({
				nftId: "nft_test123",
				price: { amount: "001.000", currency: "HIVE" },
				owner: "alice",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const errorMessages = result.errors.map((e) => e.message);
				const hasPriceError = errorMessages.some((msg) =>
					msg.toLowerCase().includes("price") || msg.toLowerCase().includes("decimal"),
				);
				expect(hasPriceError).toBe(true);
			}
		});

		test("valid price (1.000) does not produce price errors", () => {
			const result = buildList({
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

describe("Builder pack transfer username validation", () => {
	describe("buildPackTransfer rejects invalid usernames", () => {
		test("rejects username too short (ab)", () => {
			const result = buildPackTransfer({
				packId: "pack_test123",
				to: "ab",
				quantity: 1,
				from: "alice",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const errorFields = result.errors.map((e) => e.field);
				expect(errorFields).toContain("to");
			}
		});

		test("valid username does not produce username error on 'to'", () => {
			const result = buildPackTransfer({
				packId: "pack_test123",
				to: "alice",
				quantity: 1,
				from: "bob123",
			});

			if (!result.success) {
				const toErrors = result.errors.filter((e) => e.field === "to");
				expect(toErrors.length).toBe(0);
			}
		});
	});
});

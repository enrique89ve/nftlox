import { describe, it, expect } from "bun:test";
import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	ALL_ACTIONS,
	CORE_ACTIONS,
	MARKETPLACE_ACTIONS,
	APPROVE_ACTIONS,
	LENDING_ACTIONS,
	DATA_OPERATOR_ACTIONS,
	MIN_SYMBOL_LENGTH,
	MAX_SYMBOL_LENGTH,
	SYMBOL_REGEX,
	HIVE_BLOCK_TIME_MS,
	HIVE_DECIMALS,
	HIVE_PRECISION,
	isProtocolAction,
} from "../src/constants.ts";

describe("constants", () => {
	describe("PROTOCOL_ID", () => {
		it("has network-scoped shape", () => {
			expect(PROTOCOL_ID).toMatch(/^nftlox(_[a-z]+)?$/);
		});
	});

	describe("PROTOCOL_VERSION", () => {
		it("is semver", () => {
			expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		});
	});

	describe("ALL_ACTIONS", () => {
		it("is union of all category arrays", () => {
			const combined = [
				...CORE_ACTIONS,
				...MARKETPLACE_ACTIONS,
				...APPROVE_ACTIONS,
				...LENDING_ACTIONS,
				...DATA_OPERATOR_ACTIONS,
			];
			expect([...ALL_ACTIONS].sort()).toEqual([...combined].sort());
		});

		it("has exactly 20 actions", () => {
			expect(ALL_ACTIONS.length).toBe(20);
		});

		it("has no duplicates", () => {
			const set = new Set(ALL_ACTIONS);
			expect(set.size).toBe(ALL_ACTIONS.length);
		});
	});

	describe("isProtocolAction", () => {
		it("accepts all canonical actions", () => {
			for (const action of ALL_ACTIONS) {
				expect(isProtocolAction(action)).toBe(true);
			}
		});

		it("rejects invalid strings", () => {
			expect(isProtocolAction("invalid_action")).toBe(false);
			expect(isProtocolAction("")).toBe(false);
			expect(isProtocolAction("CREATE_COLLECTION")).toBe(false);
		});

		it("rejects non-string values", () => {
			expect(isProtocolAction(null)).toBe(false);
			expect(isProtocolAction(undefined)).toBe(false);
			expect(isProtocolAction(42)).toBe(false);
			expect(isProtocolAction({})).toBe(false);
		});
	});

	describe("SYMBOL_REGEX", () => {
		it("matches strings at the declared length bounds", () => {
			const minValid = "A".repeat(MIN_SYMBOL_LENGTH);
			const maxValid = "A".repeat(MAX_SYMBOL_LENGTH);
			expect(SYMBOL_REGEX.test(minValid)).toBe(true);
			expect(SYMBOL_REGEX.test(maxValid)).toBe(true);
		});

		it("rejects strings that are one character shy or over", () => {
			const tooShort = "A".repeat(MIN_SYMBOL_LENGTH - 1);
			const tooLong = "A".repeat(MAX_SYMBOL_LENGTH + 1);
			expect(SYMBOL_REGEX.test(tooShort)).toBe(false);
			expect(SYMBOL_REGEX.test(tooLong)).toBe(false);
		});

		it("requires uppercase alnum with leading letter", () => {
			expect(SYMBOL_REGEX.test("ABC")).toBe(true);
			expect(SYMBOL_REGEX.test("AB1")).toBe(true);
			expect(SYMBOL_REGEX.test("1AB")).toBe(false);
			expect(SYMBOL_REGEX.test("abc")).toBe(false);
		});
	});

	describe("Hive platform constants", () => {
		it("HIVE_PRECISION equals 10 ** HIVE_DECIMALS", () => {
			expect(HIVE_PRECISION).toBe(10 ** HIVE_DECIMALS);
		});

		it("HIVE_BLOCK_TIME_MS is positive and in whole milliseconds", () => {
			expect(HIVE_BLOCK_TIME_MS).toBeGreaterThan(0);
			expect(Number.isInteger(HIVE_BLOCK_TIME_MS)).toBe(true);
		});
	});
});

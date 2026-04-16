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

		it("has exactly 18 actions", () => {
			expect(ALL_ACTIONS.length).toBe(18);
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
});

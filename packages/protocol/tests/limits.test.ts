import { describe, test, expect } from "bun:test";
import { getLimit, type LimitDimension } from "../src/index.ts";

// Frozen-vector style: these tests pin the EXACT cap value at known block
// heights. The cap is a consensus parameter — a second indexer (Rust/Go)
// must produce the same number for the same (dimension, blockNum) tuple at
// every block. Editing a vector here without a corresponding hardfork entry
// in LIMIT_SCHEDULE is a consensus break and a chain-wide reindex requirement.

describe("getLimit — genesis schedule (frozen vectors)", () => {
	test("collectionsPerCreator at block 0 = 50", () => {
		expect(getLimit("collectionsPerCreator", 0)).toBe(50);
	});

	test("seedsPerCreator at block 0 = 3_000", () => {
		expect(getLimit("seedsPerCreator", 0)).toBe(3_000);
	});

	test("instancesPerCreator at block 0 = 3_000_000", () => {
		expect(getLimit("instancesPerCreator", 0)).toBe(3_000_000);
	});

	test("genesis schedule holds at far-future block numbers (no fork yet)", () => {
		// Until a hardfork is appended to LIMIT_SCHEDULE, the genesis values
		// must apply at every block height. Two indexers running at any
		// height MUST agree on these numbers.
		const FAR_FUTURE_BLOCK = 999_999_999;
		expect(getLimit("collectionsPerCreator", FAR_FUTURE_BLOCK)).toBe(50);
		expect(getLimit("seedsPerCreator", FAR_FUTURE_BLOCK)).toBe(3_000);
		expect(getLimit("instancesPerCreator", FAR_FUTURE_BLOCK)).toBe(3_000_000);
	});
});

describe("getLimit — boundary contract", () => {
	test("rejects negative blockNum", () => {
		expect(() => getLimit("collectionsPerCreator", -1)).toThrow("must be a non-negative integer");
	});

	test("rejects fractional blockNum", () => {
		expect(() => getLimit("collectionsPerCreator", 1.5)).toThrow("must be a non-negative integer");
	});

	test("rejects NaN blockNum", () => {
		expect(() => getLimit("collectionsPerCreator", Number.NaN)).toThrow("must be a non-negative integer");
	});

	test("accepts every declared dimension", () => {
		// Compile-time + runtime sanity: each LimitDimension must resolve to
		// a positive integer at genesis. If a future code change adds a new
		// dimension without a schedule entry the iteration would surface.
		const dimensions: ReadonlyArray<LimitDimension> = [
			"collectionsPerCreator",
			"seedsPerCreator",
			"instancesPerCreator",
		];
		for (const d of dimensions) {
			const value = getLimit(d, 0);
			expect(Number.isInteger(value) && value > 0).toBe(true);
		}
	});
});

import { test, expect, describe } from "bun:test";

import { deterministicRng, resolveDropTable } from "../src/index";

// ============ deterministicRng VECTORS ============

describe("deterministicRng (SHA-256)", () => {
	test("Vector 1: test-seed, index 0", () => {
		expect(deterministicRng("test-seed", 0)).toBeCloseTo(0.6388407883190451, 14);
	});

	test("Vector 2: test-seed, index 1", () => {
		expect(deterministicRng("test-seed", 1)).toBeCloseTo(0.07153829138479328, 14);
	});

	test("Vector 3: test-seed, index 2", () => {
		expect(deterministicRng("test-seed", 2)).toBeCloseTo(0.641578527515963, 14);
	});

	test("Vector 4: pack-open format seed", () => {
		expect(deterministicRng("abc123:999:alice", 0)).toBeCloseTo(0.9480245541428474, 14);
	});

	test("is deterministic: same input always same output", () => {
		const a = deterministicRng("determinism-check", 42);
		const b = deterministicRng("determinism-check", 42);
		expect(a).toBe(b);
	});

	test("different index produces different output", () => {
		const a = deterministicRng("same-seed", 0);
		const b = deterministicRng("same-seed", 1);
		expect(a).not.toBe(b);
	});

	test("output is in [0, 1)", () => {
		for (let i = 0; i < 100; i++) {
			const val = deterministicRng(`range-test-${i}`, i);
			expect(val).toBeGreaterThanOrEqual(0);
			expect(val).toBeLessThan(1);
		}
	});
});

// ============ resolveDropTable VECTORS ============

const dropTable = [
	{ seedId: "seed_common", weight: 100 },
	{ seedId: "seed_rare", weight: 20 },
	{ seedId: "seed_epic", weight: 5 },
	{ seedId: "seed_legend", weight: 1 },
];

describe("resolveDropTable (SHA-256 RNG)", () => {
	test("Vector A: 5 items from test-seed", () => {
		const result = resolveDropTable(dropTable, 5, "test-seed");
		expect(result).toEqual([
			"seed_common", "seed_common", "seed_common", "seed_common", "seed_common",
		]);
	});

	test("Vector B: 3 items from abc123:999:alice", () => {
		const result = resolveDropTable(dropTable, 3, "abc123:999:alice");
		expect(result).toEqual(["seed_rare", "seed_common", "seed_common"]);
	});

	test("Vector C: 4 items from tx123abc:92345678:player1", () => {
		const result = resolveDropTable(dropTable, 4, "tx123abc:92345678:player1");
		expect(result).toEqual(["seed_rare", "seed_rare", "seed_rare", "seed_common"]);
	});

	test("is deterministic: same inputs always same output", () => {
		const a = resolveDropTable(dropTable, 5, "det-check");
		const b = resolveDropTable(dropTable, 5, "det-check");
		expect(a).toEqual(b);
	});

	test("throws on empty drop table", () => {
		expect(() => resolveDropTable([], 1, "seed")).toThrow("dropTable cannot be empty");
	});

	test("returns correct count", () => {
		const result = resolveDropTable(dropTable, 10, "count-test");
		expect(result.length).toBe(10);
	});
});

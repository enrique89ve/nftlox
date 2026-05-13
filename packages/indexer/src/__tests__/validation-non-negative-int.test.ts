// `requireNonNegativeInt` is used at every boundary where a column or
// payload field is supposed to be an integer ≥ 0 (block heights, counters,
// supply values). Replacing `Number(x) || 0` with this guard converts a
// silent coercion-to-zero into a loud throw, so downstream invariants
// (e.g. `validateSeedSupplyForDistribution`) can trust their inputs.

import { describe, expect, test } from "bun:test";
import { requireNonNegativeInt } from "@/utils/validation.ts";

describe("requireNonNegativeInt", () => {
	test("accepts zero", () => {
		expect(requireNonNegativeInt(0, "field")).toBe(0);
	});

	test("accepts positive integers", () => {
		expect(requireNonNegativeInt(42, "field")).toBe(42);
	});

	test("throws on NaN — the case Number(corruptString) || 0 silently masks", () => {
		expect(() => requireNonNegativeInt(Number.NaN, "field")).toThrow(/field/);
	});

	test("throws on fractional numbers", () => {
		expect(() => requireNonNegativeInt(1.5, "field")).toThrow(/field/);
	});

	test("throws on negative integers", () => {
		expect(() => requireNonNegativeInt(-1, "field")).toThrow(/field/);
	});

	test("throws on null / undefined / string", () => {
		expect(() => requireNonNegativeInt(null, "field")).toThrow(/field/);
		expect(() => requireNonNegativeInt(undefined, "field")).toThrow(/field/);
		expect(() => requireNonNegativeInt("42", "field")).toThrow(/field/);
	});
});

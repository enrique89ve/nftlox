import { describe, test, expect } from "bun:test";
import {
	MIN_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	PROTOCOL_VERSION_REGEX,
	assertAcceptedProtocolVersion,
	assertValidProtocolVersion,
	compareVersions,
	isAcceptedProtocolVersion,
	isValidProtocolVersion,
	parseProtocolVersion,
} from "../src/index.ts";

describe("PROTOCOL_VERSION_REGEX", () => {
	test("accepts strict numeric semver", () => {
		expect(PROTOCOL_VERSION_REGEX.test("0.11.0")).toBe(true);
		expect(PROTOCOL_VERSION_REGEX.test("1.0.0")).toBe(true);
		expect(PROTOCOL_VERSION_REGEX.test("12.34.567")).toBe(true);
	});

	test("rejects leading zeros, prereleases, build metadata, garbage", () => {
		for (const bad of ["01.0.0", "0.01.0", "0.11.0-rc1", "1.0.0+abc", "1", "1.0", "abc", ""]) {
			expect(PROTOCOL_VERSION_REGEX.test(bad)).toBe(false);
		}
	});
});

describe("parseProtocolVersion", () => {
	test("returns the [major, minor, patch] triplet for valid input", () => {
		expect(parseProtocolVersion("0.11.0")).toEqual([0, 11, 0]);
		expect(parseProtocolVersion("12.34.567")).toEqual([12, 34, 567]);
	});

	test("returns null for malformed strings, non-strings, and edge cases", () => {
		for (const bad of ["01.0.0", "1.0", "rc1", null, undefined, 0, {}, []]) {
			expect(parseProtocolVersion(bad as unknown)).toBeNull();
		}
	});
});

describe("isValidProtocolVersion / assertValidProtocolVersion", () => {
	test("predicate narrows to string", () => {
		const v: unknown = "0.11.0";
		if (isValidProtocolVersion(v)) {
			// Type-only assertion — compile-time narrowing.
			expect(v.split(".")).toHaveLength(3);
		}
		expect(isValidProtocolVersion("0.11.0")).toBe(true);
		expect(isValidProtocolVersion("foo")).toBe(false);
		expect(isValidProtocolVersion(null)).toBe(false);
	});

	test("assert throws with a useful message", () => {
		expect(() => assertValidProtocolVersion("foo")).toThrow(/Invalid protocol version/);
		expect(() => assertValidProtocolVersion(123)).toThrow(/expected strict semver/);
		expect(() => assertValidProtocolVersion("0.11.0")).not.toThrow();
	});
});

describe("compareVersions", () => {
	test("returns -1 / 0 / 1", () => {
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
		expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
		expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
		expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
	});

	test("throws on malformed input rather than returning 0", () => {
		expect(() => compareVersions("foo", "1.0.0")).toThrow(/Invalid protocol version comparison/);
		expect(() => compareVersions("1.0.0", "foo")).toThrow(/Invalid protocol version comparison/);
	});
});

describe("isAcceptedProtocolVersion", () => {
	test("requires both well-formed and >= MIN", () => {
		expect(isAcceptedProtocolVersion(PROTOCOL_VERSION)).toBe(true);
		expect(isAcceptedProtocolVersion(MIN_PROTOCOL_VERSION)).toBe(true);
		expect(isAcceptedProtocolVersion("99.0.0")).toBe(true);
	});

	test("rejects below-min", () => {
		expect(isAcceptedProtocolVersion("0.0.1")).toBe(false);
		expect(isAcceptedProtocolVersion("0.10.0")).toBe(false);
		expect(() => assertAcceptedProtocolVersion("0.10.0")).toThrow(/below MIN_PROTOCOL_VERSION/);
	});

	test("rejects malformed without throwing", () => {
		expect(isAcceptedProtocolVersion("foo")).toBe(false);
		expect(isAcceptedProtocolVersion(null)).toBe(false);
	});
});

describe("assertAcceptedProtocolVersion", () => {
	test("passes for current version", () => {
		expect(() => assertAcceptedProtocolVersion(PROTOCOL_VERSION)).not.toThrow();
	});

	test("throws below MIN with a message naming MIN", () => {
		expect(() => assertAcceptedProtocolVersion("0.0.1")).toThrow(
			new RegExp(`below MIN_PROTOCOL_VERSION \\(${MIN_PROTOCOL_VERSION.replace(/\./g, "\\.")}\\)`),
		);
	});

	test("throws with format error for malformed input", () => {
		expect(() => assertAcceptedProtocolVersion("foo")).toThrow(/Invalid protocol version/);
		expect(() => assertAcceptedProtocolVersion(undefined)).toThrow(/Invalid protocol version/);
	});
});

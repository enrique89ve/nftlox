import { describe, test, expect } from "bun:test";
import { validateHiveUsername } from "../src/index.ts";

describe("validateHiveUsername", () => {
	test("accepts valid usernames", () => {
		expect(validateHiveUsername("alice")).toBeNull();
		expect(validateHiveUsername("bob-smith")).toBeNull();
		expect(validateHiveUsername("user123")).toBeNull();
		expect(validateHiveUsername("abc.def.ghi")).toBeNull();
	});

	test("rejects empty", () => {
		expect(validateHiveUsername("")).not.toBeNull();
	});

	test("rejects too short", () => {
		expect(validateHiveUsername("ab")).not.toBeNull();
	});

	test("rejects too long", () => {
		expect(validateHiveUsername("a".repeat(17))).not.toBeNull();
	});

	test("rejects uppercase", () => {
		expect(validateHiveUsername("Alice")).not.toBeNull();
	});

	test("rejects special characters", () => {
		expect(validateHiveUsername("alice!")).not.toBeNull();
	});

	test("rejects segments shorter than 3", () => {
		expect(validateHiveUsername("ab.cde")).not.toBeNull();
	});
});

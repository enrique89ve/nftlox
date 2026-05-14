import { test, expect, describe } from "bun:test";
import { validateHiveUsername } from "../src/protocol-exports";
import { usernameSchema } from "../src/schemas";

describe("validateHiveUsername", () => {
	describe("Valid usernames (should return null)", () => {
		test("standard lowercase names", () => {
			expect(validateHiveUsername("alice")).toBeNull();
			expect(validateHiveUsername("bob")).toBeNull();
			expect(validateHiveUsername("hiveuser1")).toBeNull();
		});

		test("names with hyphens", () => {
			expect(validateHiveUsername("my-account")).toBeNull();
			expect(validateHiveUsername("test-user-1")).toBeNull();
		});

		test("names with dots (each segment >= 3 chars)", () => {
			expect(validateHiveUsername("alice.bob.car")).toBeNull();
		});

		test("minimum length (3 chars)", () => {
			expect(validateHiveUsername("abc")).toBeNull();
		});

		test("maximum length (16 chars)", () => {
			expect(validateHiveUsername("abcdefghijklmnop")).toBeNull();
		});

		test("digits in middle or end", () => {
			expect(validateHiveUsername("user123")).toBeNull();
			expect(validateHiveUsername("abc1def")).toBeNull();
		});
	});

	describe("Invalid usernames (should return error string)", () => {
		test("empty string", () => {
			const result = validateHiveUsername("");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("too short (2 chars)", () => {
			const result = validateHiveUsername("ab");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("too long (17 chars)", () => {
			const result = validateHiveUsername("abcdefghijklmnopq");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("starts with number", () => {
			const result = validateHiveUsername("1user");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("starts with hyphen", () => {
			const result = validateHiveUsername("-user");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("uppercase letters", () => {
			const resultMixed = validateHiveUsername("Alice");
			expect(resultMixed).toBeTypeOf("string");
			expect(resultMixed).not.toBeNull();

			const resultAllUpper = validateHiveUsername("ALICE");
			expect(resultAllUpper).toBeTypeOf("string");
			expect(resultAllUpper).not.toBeNull();
		});

		test("consecutive dots", () => {
			const result = validateHiveUsername("abc..def");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("trailing dot", () => {
			const result = validateHiveUsername("abc.");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("leading dot", () => {
			const result = validateHiveUsername(".abc");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("segment too short (first segment 'ab' < 3 chars)", () => {
			const result = validateHiveUsername("ab.cde");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("segment too short with dot ('a.bb')", () => {
			const result = validateHiveUsername("a.bb");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("special characters (@, _, space)", () => {
			const resultAt = validateHiveUsername("alice@bob");
			expect(resultAt).toBeTypeOf("string");
			expect(resultAt).not.toBeNull();

			const resultUnderscore = validateHiveUsername("user_name");
			expect(resultUnderscore).toBeTypeOf("string");
			expect(resultUnderscore).not.toBeNull();

			const resultSpace = validateHiveUsername("user name");
			expect(resultSpace).toBeTypeOf("string");
			expect(resultSpace).not.toBeNull();
		});

		test("ends with hyphen", () => {
			const result = validateHiveUsername("abc-");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("segment starts with digit (after dot)", () => {
			const result = validateHiveUsername("abc.1de");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});

		test("segment starts with hyphen (after dot)", () => {
			const result = validateHiveUsername("abc.-de");
			expect(result).toBeTypeOf("string");
			expect(result).not.toBeNull();
		});
	});
});

describe("usernameSchema (Zod)", () => {
	describe("Valid usernames should pass safeParse", () => {
		const validUsernames = [
			"alice",
			"bob",
			"hiveuser1",
			"my-account",
			"test-user-1",
			"alice.bob.car",
			"abc",
			"abcdefghijklmnop",
			"user123",
			"abc1def",
		];

		for (const username of validUsernames) {
			test(`"${username}" should be valid`, () => {
				const result = usernameSchema.safeParse(username);
				expect(result.success).toBe(true);
			});
		}
	});

	describe("Invalid usernames should fail safeParse", () => {
		const invalidUsernames = [
			{ value: "", label: "empty string" },
			{ value: "ab", label: "too short (2 chars)" },
			{ value: "abcdefghijklmnopq", label: "too long (17 chars)" },
			{ value: "1user", label: "starts with number" },
			{ value: "-user", label: "starts with hyphen" },
			{ value: "Alice", label: "mixed case" },
			{ value: "ALICE", label: "all uppercase" },
			{ value: "abc..def", label: "consecutive dots" },
			{ value: "abc.", label: "trailing dot" },
			{ value: ".abc", label: "leading dot" },
			{ value: "ab.cde", label: "first segment too short" },
			{ value: "a.bb", label: "both segments too short" },
			{ value: "alice@bob", label: "contains @" },
			{ value: "user_name", label: "contains underscore" },
			{ value: "user name", label: "contains space" },
			{ value: "abc-", label: "ends with hyphen" },
			{ value: "abc.1de", label: "segment starts with digit" },
			{ value: "abc.-de", label: "segment starts with hyphen" },
		];

		for (const { value, label } of invalidUsernames) {
			test(`"${value}" should be invalid (${label})`, () => {
				const result = usernameSchema.safeParse(value);
				expect(result.success).toBe(false);
			});
		}
	});
});

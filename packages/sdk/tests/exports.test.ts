import { test, expect, describe } from "bun:test";

import {
	// New exports
	validateHiveUsername,
	txIdSchema,
	usernameSchema,
	priceSchema,
	// Existing exports (regression check)
	PROTOCOL_ID,
	buildArchiveCollection,
	buildCollection,
	createPayload,
	createHiveOperation,
	generateOriginDna,
} from "../src/index";

// ============ 1. New exports exist and are the correct type ============

describe("New exports exist and have the correct type", () => {
	test("validateHiveUsername is a function", () => {
		expect(typeof validateHiveUsername).toBe("function");
	});

	test("txIdSchema is a Zod schema (has .safeParse)", () => {
		expect(typeof txIdSchema.safeParse).toBe("function");
	});

	test("usernameSchema is a Zod schema (has .safeParse)", () => {
		expect(typeof usernameSchema.safeParse).toBe("function");
	});

	test("priceSchema is a Zod schema (has .safeParse)", () => {
		expect(typeof priceSchema.safeParse).toBe("function");
	});
});

// ============ 2. Removed exports are gone ============

describe("Removed exports are gone", () => {
	test("HIVE_USERNAME_REGEX should NOT be exported", () => {
		const allExports = require("../src/index") as Record<string, unknown>;
		expect(allExports.HIVE_USERNAME_REGEX).toBeUndefined();
	});
});

// ============ 3. validateHiveUsername works from index ============

describe("validateHiveUsername works when imported from index", () => {
	test("valid username returns null", () => {
		expect(validateHiveUsername("alice")).toBeNull();
	});

	test("too-short username returns an error string", () => {
		const result = validateHiveUsername("ab");
		expect(typeof result).toBe("string");
		expect(result).not.toBeNull();
	});
});

// ============ 4. usernameSchema works from index ============

describe("usernameSchema works when imported from index", () => {
	test("valid username passes", () => {
		expect(usernameSchema.safeParse("alice").success).toBe(true);
	});

	test("single-char username fails", () => {
		expect(usernameSchema.safeParse("a").success).toBe(false);
	});
});

// ============ 5. txIdSchema works from index ============

describe("txIdSchema works when imported from index", () => {
	test("valid 40-char hex passes", () => {
		const validTxId = "a".repeat(40);
		expect(txIdSchema.safeParse(validTxId).success).toBe(true);
	});

	test("short string fails", () => {
		expect(txIdSchema.safeParse("abc123").success).toBe(false);
	});
});

// ============ 6. priceSchema works from index ============

describe("priceSchema works when imported from index", () => {
	test("valid price with 3 decimal places passes", () => {
		const result = priceSchema.safeParse({ amount: "1.000", currency: "HIVE" });
		expect(result.success).toBe(true);
	});

	test("price with 2 decimal places normalizes to 3", () => {
		const result = priceSchema.safeParse({ amount: "1.00", currency: "HIVE" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.amount).toBe("1.000");
	});
});

// ============ 7. Existing exports still work (no regressions) ============

describe("Existing exports still work (no regressions)", () => {
	test("PROTOCOL_ID is a string", () => {
		expect(typeof PROTOCOL_ID).toBe("string");
	});

	test("buildCollection is a function", () => {
		expect(typeof buildCollection).toBe("function");
	});

	test("buildArchiveCollection is a function", () => {
		expect(typeof buildArchiveCollection).toBe("function");
	});

	test("createPayload is a function", () => {
		expect(typeof createPayload).toBe("function");
	});

	test("createHiveOperation is a function", () => {
		expect(typeof createHiveOperation).toBe("function");
	});

	test("generateOriginDna is a function", () => {
		expect(typeof generateOriginDna).toBe("function");
	});
});

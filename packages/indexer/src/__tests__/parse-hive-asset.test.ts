// Hive consensus produces HIVE/HBD asset strings with exactly 3 decimals
// (precision = 3). A compromised RPC endpoint could ship strings with a
// different precision; the legacy parser path used `parseFloat`, which
// silently accepts `"1.00012345 HIVE"` and `"1 HIVE"`. Both would propagate
// into transfer-amount comparisons in fee-validator.ts where the
// `Math.abs(...) < 0.0005` tolerance could coincidentally match.

import { describe, expect, test } from "bun:test";
import { parseHiveAsset } from "@/scanner/hive-client.ts";

describe("parseHiveAsset — legacy string format", () => {
	test("accepts canonical 3-decimal form", () => {
		expect(parseHiveAsset("1.000 HIVE")).toEqual({ amount: 1, currency: "HIVE" });
	});

	test("rejects strings with more than 3 decimals", () => {
		expect(parseHiveAsset("1.00012345 HIVE")).toBeNull();
	});

	test("rejects strings without a decimal point", () => {
		expect(parseHiveAsset("1 HIVE")).toBeNull();
	});

	test("rejects strings with fewer than 3 decimals", () => {
		expect(parseHiveAsset("1.0 HIVE")).toBeNull();
	});
});

import { describe, expect, test } from "bun:test";
import {
	accountCreatedBeforeOperation,
	normalizeHiveTimestampToUtc,
} from "../utils/hive-timestamp.ts";

describe("Hive timestamp normalization", () => {
	test("normalizes a timezone-less Hive timestamp to canonical UTC", () => {
		expect(normalizeHiveTimestampToUtc("2020-03-06T12:22:51", "account.created"))
			.toBe("2020-03-06T12:22:51.000Z");
	});

	test("requires the account to predate the operation block", () => {
		expect(accountCreatedBeforeOperation(
			"2020-03-06T12:22:51.000Z",
			"2020-03-06T12:22:54.000Z",
		)).toBe(true);
		expect(accountCreatedBeforeOperation(
			"2020-03-06T12:22:54.000Z",
			"2020-03-06T12:22:54.000Z",
		)).toBe(false);
	});
});

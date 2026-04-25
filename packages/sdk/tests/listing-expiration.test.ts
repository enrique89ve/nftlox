import { describe, test, expect } from "bun:test";
import { MIN_LISTING_TTL_MS, MAX_LISTING_TTL_MS } from "@nftlox/protocol";
import { expireIn, expireAt } from "../src/utils/listing-expiration";

const DAY_MS = 86_400_000;

describe("expireIn", () => {
	test("returns absolute timestamp now + duration", () => {
		const before = Date.now();
		const ts = expireIn({ days: 14 });
		const after = Date.now();
		expect(ts).toBeGreaterThanOrEqual(before + 14 * DAY_MS);
		expect(ts).toBeLessThanOrEqual(after + 14 * DAY_MS);
	});

	test("sums multiple units", () => {
		const ts = expireIn({ days: 7, hours: 12 });
		const expected = Date.now() + 7 * DAY_MS + 12 * 3_600_000;
		expect(Math.abs(ts - expected)).toBeLessThan(50);
	});

	test("rejects when no unit is provided", () => {
		expect(() => expireIn({})).toThrow(/at least one unit/);
	});

	test("rejects when total duration is zero or negative", () => {
		expect(() => expireIn({ days: 0 })).toThrow();
		expect(() => expireIn({ days: -1 })).toThrow();
	});

	test("rejects non-finite values", () => {
		expect(() => expireIn({ days: NaN })).toThrow(/finite/);
		expect(() => expireIn({ hours: Infinity })).toThrow(/finite/);
	});

	test("rejects below MIN_LISTING_TTL_MS", () => {
		expect(() => expireIn({ minutes: 5 })).toThrow(/below MIN_LISTING_TTL_MS/);
	});

	test("rejects above MAX_LISTING_TTL_MS", () => {
		expect(() => expireIn({ days: 365 })).toThrow(/exceeds MAX_LISTING_TTL_MS/);
	});

	test("accepts the exact MIN bound", () => {
		const minMs = MIN_LISTING_TTL_MS;
		const days = minMs / DAY_MS;
		expect(() => expireIn({ days })).not.toThrow();
	});

	test("accepts the exact MAX bound", () => {
		const maxMs = MAX_LISTING_TTL_MS;
		const days = maxMs / DAY_MS;
		expect(() => expireIn({ days })).not.toThrow();
	});
});

describe("expireAt", () => {
	test("accepts a Date in the valid window", () => {
		const target = new Date(Date.now() + 14 * DAY_MS);
		expect(expireAt(target)).toBe(target.getTime());
	});

	test("accepts an ISO 8601 string", () => {
		const target = new Date(Date.now() + 14 * DAY_MS);
		expect(expireAt(target.toISOString())).toBe(target.getTime());
	});

	test("rejects invalid date input", () => {
		expect(() => expireAt("not a date")).toThrow(/invalid date/);
	});

	test("rejects targets too soon", () => {
		const target = new Date(Date.now() + 60_000);
		expect(() => expireAt(target)).toThrow(/too soon/);
	});

	test("rejects targets too far", () => {
		const target = new Date(Date.now() + 365 * DAY_MS);
		expect(() => expireAt(target)).toThrow(/too far/);
	});
});

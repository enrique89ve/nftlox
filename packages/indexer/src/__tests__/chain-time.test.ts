import { describe, expect, test } from "bun:test";
import {
	estimateIndexedChainTimeMs,
	resolveChainReferenceTimeMs,
	selectChainReferenceTimeMs,
} from "@/utils/chain-time.ts";

describe("chain-time helpers", () => {
	test("estimates indexed chain time from head block/time and current lag", () => {
		const estimated = estimateIndexedChainTimeMs({
			lastBlock: 1_000,
			hiveHeadBlock: 1_003,
			hiveHeadTime: "2026-04-23T00:00:09.000Z",
		});

		expect(estimated).toBe(Date.parse("2026-04-23T00:00:00.000Z"));
	});

	test("falls back to local time when head time is unavailable", () => {
		expect(selectChainReferenceTimeMs({
			lastBlock: 1_000,
			hiveHeadBlock: 1_001,
			hiveHeadTime: null,
		}, 123_456)).toBe(123_456);
	});

	test("reports missing chain time instead of silently selecting local time", () => {
		const result = resolveChainReferenceTimeMs({
			lastBlock: 1_000,
			hiveHeadBlock: 1_001,
			hiveHeadTime: null,
		});

		expect(result).toEqual({ ok: false, reason: "missing_head_time" });
	});
});

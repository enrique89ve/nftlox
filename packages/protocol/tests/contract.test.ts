import { describe, test, expect } from "bun:test";
import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	ALL_ACTIONS,
	ACTION_AUTH_LEVEL,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	PROTOCOL_FEE_BPS,
	MAX_ROYALTY_PCT,
	MAX_BULK_DISTRIBUTE_ITEMS,
	MAX_TRANSFER_BATCH_SIZE,
	ORIGIN_DNA_LENGTH,
	INSTANCE_DNA_LENGTH,
	ACCESS_KEY_LENGTH,
	INSTANCE_ID_HASH_LENGTH,
	createPayload,
	createHiveOperation,
	getKeyType,
	getAuthLevel,
} from "../src/index";

describe("protocol contract integrity", () => {
	test("PROTOCOL_ID is network-scoped", () => {
		expect(PROTOCOL_ID).toMatch(/^nftlox(_[a-z]+)?$/);
	});

	test("18 actions, 2 active + 16 posting, no overlap", () => {
		expect(ALL_ACTIONS.length).toBe(18);
		expect(ACTIVE_AUTH_ACTIONS.length).toBe(2);
		expect(POSTING_AUTH_ACTIONS.length).toBe(16);

		const activeSet = new Set<string>(ACTIVE_AUTH_ACTIONS);
		const overlap = POSTING_AUTH_ACTIONS.filter((a) => activeSet.has(a));
		expect(overlap).toEqual([]);
	});

	test("ACTION_AUTH_LEVEL keys = ALL_ACTIONS", () => {
		expect(Object.keys(ACTION_AUTH_LEVEL).sort()).toEqual([...ALL_ACTIONS].sort());
	});

	test("createPayload + createHiveOperation round-trips", () => {
		const payload = createPayload("transfer", { nftId: "nft_1", from: "a", to: "b" });
		const op = createHiveOperation(payload, "alice");
		const parsed = JSON.parse(op[1].json) as {
			readonly action: string;
			readonly protocol: string;
			readonly version: string;
		};
		expect(parsed.action).toBe("transfer");
		expect(parsed.protocol).toBe(PROTOCOL_ID);
		expect(parsed.version).toBe(PROTOCOL_VERSION);
	});

	test("getKeyType matches getAuthLevel for all actions", () => {
		for (const action of ALL_ACTIONS) {
			const level = getAuthLevel(action);
			const keyType = getKeyType(action);
			expect(keyType).toBe(level === "active" ? "Active" : "Posting");
		}
	});

	test("fee and royalty bounds are sane", () => {
		expect(PROTOCOL_FEE_BPS).toBeGreaterThan(0);
		expect(PROTOCOL_FEE_BPS).toBeLessThanOrEqual(1000);
		expect(MAX_ROYALTY_PCT).toBeGreaterThan(0);
		expect(MAX_ROYALTY_PCT).toBeLessThanOrEqual(50);
	});

	test("batch limits are positive", () => {
		expect(MAX_BULK_DISTRIBUTE_ITEMS).toBeGreaterThan(0);
		expect(MAX_TRANSFER_BATCH_SIZE).toBeGreaterThan(0);
	});

	test("DNA lengths are positive", () => {
		expect(ORIGIN_DNA_LENGTH).toBeGreaterThan(0);
		expect(INSTANCE_DNA_LENGTH).toBeGreaterThan(0);
		expect(ACCESS_KEY_LENGTH).toBeGreaterThan(0);
		expect(INSTANCE_ID_HASH_LENGTH).toBeGreaterThan(0);
	});
});

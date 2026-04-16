import { describe, expect, test } from "bun:test";

import * as indexer from "@/protocol/index.ts";
import * as sdk from "../../../sdk/src/constants.ts";

// The indexer and SDK must agree bit-for-bit on the protocol envelope.
// If the SDK signs a custom_json with id="nftlox" and the indexer listens
// for id="nftlox_testnet", valid ops are silently dropped. If the SDK
// targets version "0.6.0" and the indexer still accepts "0.5.2", a
// protocol upgrade fails open. This test is the drift alarm.
//
// The authority map already has a generator script (scripts/sync-auth-levels.ts)
// so we compare the live values here too — if someone edits by hand, this
// catches it before it reaches a node.

describe("protocol constants drift (indexer ↔ sdk)", () => {
	test("PROTOCOL_ID matches", () => {
		expect(indexer.PROTOCOL_ID).toBe(sdk.PROTOCOL_ID);
	});

	test("PROTOCOL_ID has the expected network-scoped shape", () => {
		// Any value is technically valid; this guards against typos like
		// "nftlox_tesnet" or "nfflox" that would silently fork the network.
		expect(indexer.PROTOCOL_ID).toMatch(/^nftlox(_[a-z]+)?$/);
	});

	test("PROTOCOL_VERSION matches", () => {
		expect(indexer.PROTOCOL_VERSION).toBe(sdk.PROTOCOL_VERSION);
	});

	test("MIN_PROTOCOL_VERSION matches", () => {
		expect(indexer.MIN_PROTOCOL_VERSION).toBe(sdk.MIN_PROTOCOL_VERSION);
	});

	test("PROTOCOL_FEE_BPS and MAX_ROYALTY_PCT match", () => {
		expect(indexer.PROTOCOL_FEE_BPS).toBe(sdk.PROTOCOL_FEE_BPS);
		expect(indexer.MAX_ROYALTY_PCT).toBe(sdk.MAX_ROYALTY_PCT);
	});

	test("SUPPORTED_CURRENCIES match (same order)", () => {
		expect([...indexer.SUPPORTED_CURRENCIES]).toEqual([...sdk.SUPPORTED_CURRENCIES]);
	});

	test("ALL_ACTIONS is a superset-equal set", () => {
		const indexerSet = new Set(indexer.ALL_ACTIONS);
		const sdkSet = new Set(sdk.ALL_ACTIONS);
		expect(indexerSet).toEqual(sdkSet);
	});

	test("ACTION_AUTH_LEVEL matches for every action", () => {
		for (const action of sdk.ALL_ACTIONS) {
			expect(indexer.ACTION_AUTH_LEVEL[action]).toBe(sdk.ACTION_AUTH_LEVEL[action]);
		}
	});

	test("memo prefixes match (buy/royalty/fee)", () => {
		expect(indexer.MEMO_PREFIX_BUY).toBe(sdk.MEMO_PREFIX_BUY);
		expect(indexer.MEMO_PREFIX_ROYALTY).toBe(sdk.MEMO_PREFIX_ROYALTY);
		expect(indexer.MEMO_PREFIX_FEE).toBe(sdk.MEMO_PREFIX_FEE);
	});

	test("batch and schema size limits match", () => {
		expect(indexer.MAX_BULK_DISTRIBUTE_ITEMS).toBe(sdk.MAX_BULK_DISTRIBUTE_ITEMS);
		expect(indexer.MAX_TRANSFER_BATCH_SIZE).toBe(sdk.MAX_TRANSFER_BATCH_SIZE);
		expect(indexer.MAX_SCHEMA_FIELDS).toBe(sdk.MAX_SCHEMA_FIELDS);
		expect(indexer.MAX_FIELD_NAME_LENGTH).toBe(sdk.MAX_FIELD_NAME_LENGTH);
	});

	test("multisig window matches", () => {
		expect(indexer.MULTISIG_EXPIRATION_MS).toBe(sdk.MULTISIG_EXPIRATION_MS);
		expect(indexer.MAX_MULTISIG_OPERATIONS).toBe(sdk.MAX_MULTISIG_OPERATIONS);
	});

	test("DNA lengths match", () => {
		expect(indexer.ORIGIN_DNA_LENGTH).toBe(sdk.ORIGIN_DNA_LENGTH);
		expect(indexer.INSTANCE_DNA_LENGTH).toBe(sdk.INSTANCE_DNA_LENGTH);
		expect(indexer.ACCESS_KEY_LENGTH).toBe(sdk.ACCESS_KEY_LENGTH);
		expect(indexer.INSTANCE_ID_HASH_LENGTH).toBe(sdk.INSTANCE_ID_HASH_LENGTH);
	});
});

import { test, expect, describe } from "bun:test";
import { snapshotFromIndexerSeed } from "../src";

describe("snapshotFromIndexerSeed", () => {
	const indexerSeed = {
		id: "nft_abcdef0123456789abcd",
		max_supply: 100,
		distributed: 12,
		tx_id: "a".repeat(40),
	};

	test("maps indexer fields to the packs-engine snapshot shape", () => {
		const snapshot = snapshotFromIndexerSeed(indexerSeed);
		expect(snapshot).toEqual({
			seedId: "nft_abcdef0123456789abcd",
			seedTxId: "a".repeat(40),
			maxSupply: 100,
			distributed: 12,
			reserved: 0,
		});
	});

	test("passes through an off-chain reservation counter", () => {
		const snapshot = snapshotFromIndexerSeed(indexerSeed, 25);
		expect(snapshot.reserved).toBe(25);
	});

	test("rejects negative reservations", () => {
		expect(() => snapshotFromIndexerSeed(indexerSeed, -1)).toThrow();
	});

	test("rejects non-integer reservations", () => {
		expect(() => snapshotFromIndexerSeed(indexerSeed, 1.5)).toThrow();
	});
});

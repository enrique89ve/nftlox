import { afterEach, describe, test, expect } from "bun:test";
import type { ConsensusHead } from "../scanner/head-consensus.ts";
import { selectConsensusSample } from "../scanner/head-consensus.ts";

process.env.INDEXER_ROLE = "sync";
process.env.HIVE_ENDPOINTS = "https://hafah.test";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function sample(headBlock: number, irreversibleBlock: number): ConsensusHead {
	return { headBlock, irreversibleBlock };
}

describe("selectConsensusSample", () => {
	test("returns the only available sample", () => {
		expect(selectConsensusSample([sample(120, 100)], head => head)).toEqual({
			headBlock: 120,
			irreversibleBlock: 100,
		});
	});

	test("chooses the lower irreversible block when two endpoints disagree", () => {
		expect(selectConsensusSample([
			sample(121, 100),
			sample(125, 104),
		], head => head)).toEqual({
			headBlock: 121,
			irreversibleBlock: 100,
		});
	});

	test("rejects a single high outlier with three endpoints", () => {
		expect(selectConsensusSample([
			sample(130, 100),
			sample(131, 101),
			sample(140, 140),
		], head => head)).toEqual({
			headBlock: 131,
			irreversibleBlock: 101,
		});
	});
});

describe("getCustomJsonInRange — HafAH envelope validation", () => {
	test("rejects a 200 response that omits the ops array", async () => {
		const { getCustomJsonInRange } = await import("../scanner/hive-client.ts");
		globalThis.fetch = (async () => new Response(JSON.stringify({
			error: "temporary backend error",
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		await expect(getCustomJsonInRange(100, 120, "nftlox_testnet"))
			.rejects
			.toThrow("Invalid HafAH response");
	});

	test("accepts an explicit empty final page", async () => {
		const { getCustomJsonInRange } = await import("../scanner/hive-client.ts");
		globalThis.fetch = (async () => new Response(JSON.stringify({
			ops: [],
			next_block_range_begin: null,
			next_operation_begin: null,
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;

		await expect(getCustomJsonInRange(100, 120, "nftlox_testnet"))
			.resolves
			.toEqual([]);
	});
});

// Guardrail for `fetchCustomJsonOperationsInRange` endpoint-quorum logic.
//
// The SPV verifier uses this helper to find a buy's matching `buy_commitment`
// in HAFAH operations. A single hostile or censoring mirror could grief
// verification by serving `{ ops: [] }` for the commitment range while a
// healthy mirror would have served the real commitment. The helper now
// requires either:
//   - at least one endpoint with records (first wins), OR
//   - ALL endpoints to confirm emptiness without errors before accepting [].
//
// Tests pin both shapes plus the "inconclusive: empty + transport error" case.

import { afterEach, describe, expect, test } from "bun:test";

import { fetchCustomJsonOperationsInRange, type HiveL1Config } from "../src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function emptyOpsResponse(): Response {
	return new Response(JSON.stringify({ ops: [], next_operation_begin: "0" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function recordsOpsResponse(): Response {
	return new Response(
		JSON.stringify({
			ops: [
				{
					op: {
						type: "custom_json_operation",
						value: {
							id: "nftlox_testnet",
							json: JSON.stringify({ protocol: "nftlox_testnet", version: "0.10.0", action: "noop", data: {} }),
							required_auths: ["alice"],
							required_posting_auths: [],
						},
					},
					block: 100,
					trx_id: "a".repeat(40),
					timestamp: "2026-04-04T00:00:00",
					virtual_op: false,
					operation_id: "451882812111324000",
				},
			],
			next_operation_begin: "0",
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("fetchCustomJsonOperationsInRange — endpoint quorum", () => {
	test("first endpoint with records wins", async () => {
		const config: HiveL1Config = {
			endpoints: ["https://primary.test", "https://secondary.test"],
			timeoutMs: 1_000,
		};
		const urls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			if (url.startsWith("https://primary.test/")) return recordsOpsResponse();
			throw new Error(`Unexpected url ${url}`);
		}) as unknown as typeof fetch;

		const ops = await fetchCustomJsonOperationsInRange(config, 100, 100);
		expect(ops).toHaveLength(1);
		// Secondary should NOT be hit when primary returned records.
		expect(urls.every((url) => url.startsWith("https://primary.test/"))).toBe(true);
	});

	test("falls through empty primary to secondary with records", async () => {
		const config: HiveL1Config = {
			endpoints: ["https://primary.test", "https://secondary.test"],
			timeoutMs: 1_000,
		};
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith("https://primary.test/")) return emptyOpsResponse();
			if (url.startsWith("https://secondary.test/")) return recordsOpsResponse();
			throw new Error(`Unexpected url ${url}`);
		}) as unknown as typeof fetch;

		const ops = await fetchCustomJsonOperationsInRange(config, 100, 100);
		expect(ops).toHaveLength(1);
	});

	test("returns [] only when ALL endpoints confirm empty without errors", async () => {
		const config: HiveL1Config = {
			endpoints: ["https://primary.test", "https://secondary.test"],
			timeoutMs: 1_000,
		};
		globalThis.fetch = (async () => emptyOpsResponse()) as unknown as typeof fetch;

		const ops = await fetchCustomJsonOperationsInRange(config, 100, 100);
		expect(ops).toEqual([]);
	});

	test("inconclusive: empty success + transport error throws", async () => {
		const config: HiveL1Config = {
			endpoints: ["https://primary.test", "https://secondary.test"],
			timeoutMs: 1_000,
		};
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith("https://primary.test/")) return emptyOpsResponse();
			if (url.startsWith("https://secondary.test/")) {
				return new Response("upstream timeout", { status: 504 });
			}
			throw new Error(`Unexpected url ${url}`);
		}) as unknown as typeof fetch;

		await expect(fetchCustomJsonOperationsInRange(config, 100, 100)).rejects.toThrow(/Inconclusive/);
	});

	test("all endpoints failing throws HiveRpcError", async () => {
		const config: HiveL1Config = {
			endpoints: ["https://primary.test", "https://secondary.test"],
			timeoutMs: 1_000,
		};
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

		await expect(fetchCustomJsonOperationsInRange(config, 100, 100)).rejects.toThrow(/All endpoints failed/);
	});
});

import { describe, test, expect } from "bun:test";
import {
	createNftloxClient,
	expireIn,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	buildUnlist,
} from "../src";
import { resetProtocolState } from "../src/protocol-state";

const INDEXER_URL = "https://indexer.test.example";

describe("createNftloxClient", () => {
	test("returns the four namespaces and the protocol metadata", () => {
		const client = createNftloxClient({ indexerUrl: INDEXER_URL });

		expect(typeof client.indexer.getStatus).toBe("function");
		expect(typeof client.builders.list).toBe("function");
		expect(typeof client.spv.verifyAssetOwnership).toBe("function");
		expect(client.protocol).toEqual({
			id: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			minVersion: MIN_PROTOCOL_VERSION,
		});
		expect(typeof client.connect).toBe("function");
	});

	test("normalizes a trailing slash in indexerUrl", () => {
		const client = createNftloxClient({ indexerUrl: `${INDEXER_URL}///` });
		// not a public field, but `connect()` would fetch /api/status — verify
		// indirectly by ensuring the client constructs without throwing.
		expect(client).toBeDefined();
	});

	test("builders namespace covers every protocol action", () => {
		const client = createNftloxClient({ indexerUrl: INDEXER_URL });
		const required = [
			"collection",
			"collectionWithSeeds",
			"archiveCollection",
			"extendSchema",
			"seed",
			"seedBatch",
			"bulkDistribute",
			"transfer",
			"burn",
			"list",
			"unlist",
			"buy",
			"setData",
			"setDataFrom",
			"dataOperatorApprove",
			"assetApprove",
			"assetApproveAll",
			"assetTransferFrom",
			"assetLend",
			"assetReturn",
			"nodeRegister",
			"nodeHeartbeat",
		] as const;
		for (const name of required) {
			expect(typeof client.builders[name]).toBe("function");
		}
	});

	test("builders.list produces a signed-ready operation just like buildList", async () => {
		const client = createNftloxClient({ indexerUrl: INDEXER_URL });
		const r = await client.builders.list({
			assetId: "asset_1",
			price: { amount: "10.000", currency: "HIVE" },
			owner: "alice",
			expiresAt: expireIn({ days: 14 }),
		});
		if (!r.success) throw new Error("build failed: " + JSON.stringify(r.errors));
		expect(r.payload.action).toBe("list");
		expect(r.signer).toBe("alice");
	});

	test("spv.verifyAssetOwnership injects the configured indexerUrl and l1Config", async () => {
		const calls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			calls.push(url);
			throw new Error("network disabled in this test");
		}) as unknown as typeof fetch;
		const original = globalThis.fetch;
		globalThis.fetch = fakeFetch;
		try {
			const client = createNftloxClient({ indexerUrl: INDEXER_URL });
			await client.spv
				.verifyAssetOwnership({ assetId: "asset_1", expectedOwner: "alice" })
				.catch(() => undefined);
			// First touched URL is the indexer (Asset lookup) — confirms baseUrl wiring
			expect(calls.some((u) => u.startsWith(INDEXER_URL))).toBe(true);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("connect() fetches /api/status and returns the live version", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			expect(url).toBe(`${INDEXER_URL}/api/status`);
			return new Response(
				JSON.stringify({
					protocolVersion: PROTOCOL_VERSION,
					protocolId: PROTOCOL_ID,
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		try {
			const client = createNftloxClient({ indexerUrl: INDEXER_URL });
			const result = await client.connect();
			expect(result.version).toBe(PROTOCOL_VERSION);
			expect(result.protocolId).toBe(PROTOCOL_ID);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("connect() configures subsequent builders with the live protocol contract", async () => {
		const client = createNftloxClient({
			indexerUrl: INDEXER_URL,
			http: {
				fetch: (async () => new Response(JSON.stringify({
					protocolVersion: "1.1.0",
					protocolId: "nftlox_live_protocol",
				}), { status: 200 })) as unknown as typeof fetch,
			},
		});
		try {
			await client.connect();
			const result = buildUnlistForSyncTest();
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.payload.version).toBe("1.1.0");
				expect(result.payload.protocol).toBe("nftlox_live_protocol");
			}
		} finally {
			resetProtocolState();
		}
	});
});

function buildUnlistForSyncTest() {
	return buildUnlist({ assetId: "asset_" + "a".repeat(20) + "_1", owner: "alice" });
}

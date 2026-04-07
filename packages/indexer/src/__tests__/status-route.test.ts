import { describe, expect, mock, test } from "bun:test";

mock.module("@/db/queries/sync.ts", () => ({
	getLastBlock: () => Promise.resolve(995),
	getSyncStatus: () => Promise.resolve({ lastBlock: 995, updatedAt: new Date() }),
	getOperationStatus: () => Promise.resolve([]),
}));

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockchainHead: () => Promise.resolve({ headBlock: 1000, irreversibleBlock: 1000 }),
	checkClockDrift: () => Promise.resolve({ ok: true, driftMs: 1000 }),
}));

mock.module("@/db/queries/stats.ts", () => ({
	getProtocolStats: () => Promise.resolve({ totalCollections: 1 }),
}));

mock.module("@/scanner/sync-state.ts", () => ({
	getStartupTime: () => 0,
}));

mock.module("@/scanner/sync-engine.ts", () => ({
	SYNC_TOLERANCE_BLOCKS: 5,
}));

mock.module("@/config.ts", () => ({
	config: {
		protocolId: "nftlox_testnet",
		genesisBlock: 103484900,
		hiveAccount: "gametest.ing",
		nodeUrl: "",
		indexerRole: "both",
	},
}));

mock.module("@/api/services/multisig-health.ts", () => ({
	getMultisigHealth: () => ({
		multisigEnabled: false,
		multisigSignerReady: true,
		multisigClockDriftOk: false,
		multisigClockDriftMs: 20000,
		multisigLastCheckedAt: Date.now(),
		disabledReason: "clock_drift",
	}),
}));

mock.module("@/protocol/index.ts", () => ({
	PROTOCOL_VERSION: "0.2.1",
	PROTOCOL_FEE_PCT: 2.5,
	MAX_ROYALTY_PCT: 50,
	SUPPORTED_CURRENCIES: ["HIVE", "HBD"],
	ALL_ACTIONS: ["buy", "list"],
}));

const { Elysia } = await import("elysia");
const { statusRoutes } = await import("@/api/routes/status.ts");

describe("status route", () => {
	test("exposes multisig health fields without breaking multisigEnabled", async () => {
		const app = new Elysia().use(statusRoutes);
		const response = await app.handle(new Request("http://localhost/api/status"));
		const json = await response.json() as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(json.multisigEnabled).toBe(false);
		expect(json.multisigSignerReady).toBe(true);
		expect(json.multisigClockDriftOk).toBe(false);
		expect(json.multisigClockDriftMs).toBe(20000);
	});
});

import { afterAll, describe, expect, mock, test } from "bun:test";

const fixedNowMs = Date.parse("2026-04-07T12:00:00.000Z");
const realDateNow = Date.now;
Date.now = () => fixedNowMs;

type MockSyncStatus = {
	lastBlock: number;
	updatedAt: Date | null;
};

type MockChainStatus = {
	headBlock: number;
	irreversibleBlock: number;
};

let mockSyncStatus: MockSyncStatus = { lastBlock: 995, updatedAt: new Date(fixedNowMs - 10_000) };
let mockChainStatus: MockChainStatus = { headBlock: 1000, irreversibleBlock: 1000 };
let mockStartupTime = fixedNowMs - 30_000;

mock.module("@/db/queries/sync.ts", () => ({
	getLastBlock: () => Promise.resolve(995),
	getSyncStatus: () => Promise.resolve(mockSyncStatus),
	getOperationStatus: () => Promise.resolve([]),
}));

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockchainHead: () => Promise.resolve(mockChainStatus),
	checkClockDrift: () => Promise.resolve({ ok: true, driftMs: 1000 }),
	// Stubs keep chain-anchors.test.ts mock shape complete under bun's
	// process-wide mock registry.
	getBlockIdFromAllEndpoints: () => Promise.resolve([]),
	getCustomJsonInRange: () => Promise.resolve([]),
	getHafAHBlockRange: () => 0,
	getTransfersInTransaction: () => Promise.resolve([]),
	getHeadBlockNum: () => Promise.resolve(0),
	selectConsensusHead: () => ({ headBlock: 0, irreversibleBlock: 0 }),
}));

mock.module("@/db/queries/stats.ts", () => ({
	getProtocolStats: () => Promise.resolve({ totalCollections: 1 }),
}));

mock.module("@/scanner/sync-state.ts", () => ({
	getStartupTime: () => mockStartupTime,
}));

mock.module("@/scanner/sync-engine.ts", () => ({
	SYNC_TOLERANCE_BLOCKS: 5,
}));

mock.module("@/config.ts", () => ({
	config: {
		protocolId: "nftlox_testnet",
		genesisBlock: 105558142,
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
	PROTOCOL_FEE_BPS: 250,
	MAX_ROYALTY_PCT: 50,
	percentageToBasisPoints: (percentage: number) => Math.round(percentage * 100),
	SUPPORTED_CURRENCIES: ["HIVE", "HBD"],
	ALL_ACTIONS: ["buy", "list"],
	PROTOCOL_GENESIS_BLOCK: 105558142,
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
		expect(json.protocolFeeBps).toBe(250);
		expect(json.maxRoyaltyBps).toBe(5000);
		expect(json.genesisBlock).toBe(105558142);
	});

	test("does not expose any HIVE↔HBD price feed (HBD-only fees: consensus performs no conversion)", async () => {
		const app = new Elysia().use(statusRoutes);
		const response = await app.handle(new Request("http://localhost/api/status"));
		const json = await response.json() as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(json).not.toHaveProperty("priceFeed");
	});

	test("legacy /api/fee-estimate stays removed", async () => {
		const app = new Elysia().use(statusRoutes);
		const response = await app.handle(new Request("http://localhost/api/fee-estimate?hbd=0.1"));
		expect(response.status).toBe(404);
	});

	test("returns combined healthy status when synced", async () => {
		mockSyncStatus = { lastBlock: 995, updatedAt: new Date(fixedNowMs - 10_000) };
		mockChainStatus = { headBlock: 1000, irreversibleBlock: 1000 };
		mockStartupTime = fixedNowMs - 30_000;

		const app = new Elysia().use(statusRoutes);
		const response = await app.handle(new Request("http://localhost/api/health"));
		const json = await response.json() as Record<string, unknown>;
		const liveness = json.liveness as Record<string, unknown>;
		const readiness = json.readiness as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(json.status).toBe("healthy");
		expect(liveness.status).toBe("healthy");
		expect(liveness.sync).toBe("ready");
		expect(readiness.status).toBe("healthy");
		expect(readiness.sync).toBe("ready");
	});

	test("returns live-but-not-ready while catching up with recent activity", async () => {
		mockSyncStatus = { lastBlock: 900, updatedAt: new Date(fixedNowMs - 10_000) };
		mockChainStatus = { headBlock: 1000, irreversibleBlock: 1000 };
		mockStartupTime = fixedNowMs - 30_000;

		const app = new Elysia().use(statusRoutes);
		const response = await app.handle(new Request("http://localhost/api/health"));
		const json = await response.json() as Record<string, unknown>;
		const liveness = json.liveness as Record<string, unknown>;
		const readiness = json.readiness as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(json.status).toBe("healthy");
		expect(liveness.status).toBe("healthy");
		expect(liveness.sync).toBe("catching-up");
		expect(liveness.inSync).toBe(false);
		expect(liveness.syncActive).toBe(true);
		expect(readiness.status).toBe("unhealthy");
		expect(readiness.sync).toBe("catching-up");
	});

	test("returns unhealthy when syncing is stale", async () => {
		mockSyncStatus = { lastBlock: 900, updatedAt: new Date(fixedNowMs - 120_000) };
		mockChainStatus = { headBlock: 1000, irreversibleBlock: 1000 };
		mockStartupTime = fixedNowMs - 180_000;

		const app = new Elysia().use(statusRoutes);
		const response = await app.handle(new Request("http://localhost/api/health"));
		const json = await response.json() as Record<string, unknown>;
		const liveness = json.liveness as Record<string, unknown>;
		const readiness = json.readiness as Record<string, unknown>;

		expect(response.status).toBe(503);
		expect(json.status).toBe("unhealthy");
		expect(liveness.status).toBe("unhealthy");
		expect(liveness.sync).toBe("stale");
		expect(liveness.syncActive).toBe(false);
		expect(readiness.status).toBe("unhealthy");
		expect(readiness.sync).toBe("stale");
	});
});

afterAll(() => {
	Date.now = realDateNow;
});

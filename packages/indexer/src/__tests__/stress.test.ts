import { describe, test, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import type { ParsedOperation, ParseResult } from "@/scanner/operation-parser.ts";
import type { HafAHOperation } from "@/scanner/hive-client.ts";
import { ACTION_TRANSFER } from "@/protocol/index.ts";

// ─── Sync Engine Mocks (simulates heavy block processing) ──────────

let trackedLastBlock = 0;

const mockGetLastBlock = mock(() => Promise.resolve(trackedLastBlock));
const mockUpdateLastBlock = mock((block: number, _txn?: unknown) => {
	trackedLastBlock = block;
	return Promise.resolve();
});
const mockGetBlockchainHead = mock((_consistency?: "fast" | "strict") =>
	Promise.resolve({ headBlock: 100000, irreversibleBlock: 100000 }),
);
const mockGetCustomJsonInRange = mock(async () => {
	// Simulate HafAH network latency
	await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
	return [] as HafAHOperation[];
});
const mockGetHafAHBlockRange = mock(() => 2000);
const mockGetTransfersInTransaction = mock(async () => {
	await new Promise(r => setTimeout(r, 10));
	return [];
});
const mockParseHafAHOperations = mock((): ParseResult => ({ ops: [], rejected: [] }));
const mockRouteOperation = mock(async () => {
	await new Promise(r => setTimeout(r, 2));
});

const mockTxn = Object.assign(
	(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(),
	{ __mock: true },
);
const mockWithTransaction = mock(async (fn: (txn: unknown) => Promise<void>) => {
	await fn(mockTxn);
});

mock.module("@/db/queries/sync.ts", () => ({
	getLastBlock: mockGetLastBlock,
	updateLastBlock: mockUpdateLastBlock,
	cleanupExpiredOperations: mock(() => Promise.resolve(0)),
	insertInvalidOperation: mock(() => Promise.resolve()),
	acquireSyncLock: mock(() => Promise.resolve(true)),
	releaseSyncLock: mock(() => Promise.resolve()),
	// Stubs keep the module's export shape complete for bun's process-wide mocks.
	getSyncStatus: mock(() => Promise.resolve({ lastBlock: 0, updatedAt: new Date() })),
	getOperationStatus: mock(() => Promise.resolve([])),
	getLastBlockForUpdate: mock(() => Promise.resolve(0)),
	isOperationConfirmed: mock(() => Promise.resolve(false)),
	insertConfirmedOperation: mock(() => Promise.resolve()),
	insertOrphanedBuy: mock(() => Promise.resolve()),
}));

mock.module("@/scanner/hive-client.ts", () => ({
	getBlockchainHead: mockGetBlockchainHead,
	getCustomJsonInRange: mockGetCustomJsonInRange,
	getHafAHBlockRange: mockGetHafAHBlockRange,
	getTransfersInTransaction: mockGetTransfersInTransaction,
	checkClockDrift: mock(() => Promise.resolve()),
	// Stub keeps chain-anchors.test.ts mock shape complete under bun's
	// process-wide mock registry.
	getBlockIdFromAllEndpoints: mock(() => Promise.resolve([])),
	getHeadBlockNum: mock(() => Promise.resolve(0)),
	selectConsensusHead: () => ({ headBlock: 0, irreversibleBlock: 0 }),
}));

mock.module("@/scanner/operation-parser.ts", () => ({
	parseHafAHOperations: mockParseHafAHOperations,
}));

mock.module("@/processor/action-router.ts", () => ({
	routeOperation: mockRouteOperation,
}));

mock.module("@/db/client.ts", () => ({
	withTransaction: mockWithTransaction,
	sql: Object.assign(
		(_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
		{
			begin: (fn: (sql: unknown) => Promise<unknown>) => fn((_s: TemplateStringsArray) => Promise.resolve([])),
			end: () => Promise.resolve(),
			unsafe: (_query: string) => Promise.resolve([]),
		},
	),
	clampLimit: (limit: number, defaultVal = 50) => {
		if (limit < 1 || !Number.isFinite(limit)) return defaultVal;
		return Math.min(limit, 1000);
	},
	testConnection: () => Promise.resolve(),
	closePool: () => Promise.resolve(),
}));

const { syncCycle, setRunning } = await import("@/scanner/sync-engine.ts");
const { setSynced, updateSyncProgress } = await import("@/scanner/sync-state.ts");

// ─── Lightweight API Server (simulates real endpoints with realistic delays) ───

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Port 0 (OS-assigned) is unreliable in some WSL environments ("Is port 0 in use?").
// Try port 0 first, fall back to fixed high ports that are unlikely to conflict.
function bindTestServer(fetch: (req: Request) => Promise<Response>): ReturnType<typeof Bun.serve> {
	for (const port of [0, 47291, 47292, 47293]) {
		try {
			return Bun.serve({ port, fetch });
		} catch { /* port unavailable, try next */ }
	}
	throw new Error("No available port for stress test server");
}

const FAKE_NFT = { id: "nft_1", collection_id: "col_test", owner: "alice", status: "active" };
const FAKE_STATS = { total_collections: 10, total_nfts: 500, total_seeds: 50 };

beforeAll(() => {
	setSynced(true);
	updateSyncProgress({ lastBlock: 99990, headBlock: 100000, irreversibleBlock: 100000 });
	setRunning(true);

	server = bindTestServer(async (req) => {
			const url = new URL(req.url);
			const path = url.pathname;

			// Simulate realistic DB query delay (1-5ms)
			await new Promise(r => setTimeout(r, 1 + Math.random() * 4));

			if (path === "/api/stats") {
				return Response.json(FAKE_STATS);
			}
			if (path.startsWith("/api/nfts/")) {
				const id = path.split("/").pop();
				if (id === "not-found") {
					return Response.json({ error: "NFT not found" }, { status: 404 });
				}
				return Response.json({ ...FAKE_NFT, id });
			}
			if (path.startsWith("/api/collections/")) {
				return Response.json({ id: "col_test", name: "Test Collection" });
			}
			if (path === "/api/health") {
				return Response.json({ status: "healthy", inSync: true });
			}
			return Response.json({ error: "Not found" }, { status: 404 });
	});

	baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
	if (server) await server.stop();
	setRunning(false);
});

// ─── Helpers ────────────────────────────────────────

interface RequestResult {
	status: number;
	latencyMs: number;
}

async function fireRequest(url: string): Promise<RequestResult> {
	const start = performance.now();
	const res = await fetch(url);
	const latencyMs = performance.now() - start;
	await res.text();
	return { status: res.status, latencyMs };
}

async function fireConcurrentRequests(url: string, count: number): Promise<RequestResult[]> {
	return Promise.all(Array.from({ length: count }, () => fireRequest(url)));
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)]!;
}

function reportMetrics(label: string, results: RequestResult[]): void {
	const latencies = results.map(r => r.latencyMs);
	const successes = results.filter(r => r.status === 200).length;
	console.log(`  ${label}: ${successes}/${results.length} ok | p50=${percentile(latencies, 50).toFixed(1)}ms p95=${percentile(latencies, 95).toFixed(1)}ms p99=${percentile(latencies, 99).toFixed(1)}ms`);
}

// ─── Stress Tests ──────────────────────────────────

describe("stress: API throughput", () => {

	test("should handle 500 concurrent requests to /api/stats", async () => {
		const results = await fireConcurrentRequests(`${baseUrl}/api/stats`, 500);
		reportMetrics("500x /api/stats", results);

		const successes = results.filter(r => r.status === 200);
		expect(successes).toHaveLength(500);
		expect(percentile(results.map(r => r.latencyMs), 95)).toBeLessThan(500);
	}, 15000);

	test("should handle 1000 concurrent requests to /api/nfts/:id", async () => {
		const promises = Array.from({ length: 1000 }, (_, i) =>
			fireRequest(`${baseUrl}/api/nfts/nft_${i % 50}`),
		);
		const results = await Promise.all(promises);
		reportMetrics("1000x /api/nfts/:id", results);

		const successes = results.filter(r => r.status === 200);
		expect(successes).toHaveLength(1000);
		expect(percentile(results.map(r => r.latencyMs), 95)).toBeLessThan(500);
	}, 15000);

	test("should return correct 404s under load", async () => {
		const results = await fireConcurrentRequests(`${baseUrl}/api/nfts/not-found`, 300);
		reportMetrics("300x /api/nfts/not-found", results);

		const notFounds = results.filter(r => r.status === 404);
		expect(notFounds).toHaveLength(300);
	}, 10000);

	test("should handle mixed endpoints (1000 requests across 5 endpoints)", async () => {
		const endpoints = [
			`${baseUrl}/api/stats`,
			`${baseUrl}/api/nfts/nft_1`,
			`${baseUrl}/api/nfts/nft_2`,
			`${baseUrl}/api/nfts/not-found`,
			`${baseUrl}/api/collections/col_test`,
		];

		const promises = endpoints.flatMap(url =>
			Array.from({ length: 200 }, () => fireRequest(url)),
		);
		const results = await Promise.all(promises);
		reportMetrics("1000x mixed", results);

		const successes = results.filter(r => r.status === 200);
		const notFounds = results.filter(r => r.status === 404);
		expect(successes).toHaveLength(800);
		expect(notFounds).toHaveLength(200);
		expect(percentile(results.map(r => r.latencyMs), 95)).toBeLessThan(500);
	}, 15000);
});

describe("stress: API responsiveness during sync", () => {

	beforeEach(() => {
		trackedLastBlock = 0;
		mockGetBlockchainHead.mockResolvedValue({ headBlock: 100000, irreversibleBlock: 100000 });
		mockGetCustomJsonInRange.mockImplementation(async () => {
			await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
			return [];
		});
		mockParseHafAHOperations.mockImplementation((): ParseResult => ({ ops: [], rejected: [] }));
		mockGetHafAHBlockRange.mockReturnValue(2000);
		setRunning(true);
	});

	test("should respond to 500 API requests while sync cycle runs", async () => {
		// Configure heavy sync: massive mode with CPU-bound parsing
		trackedLastBlock = 1000;
		mockGetBlockchainHead.mockResolvedValue({ headBlock: 4000, irreversibleBlock: 4000 });
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockImplementation(async () => {
			await new Promise(r => setTimeout(r, 30)); // simulate network
			return [];
		});
		mockParseHafAHOperations.mockImplementation((): ParseResult => {
			// ~5ms CPU block per batch (realistic parsing simulation)
			const start = performance.now();
			while (performance.now() - start < 5) { /* CPU work */ }
			return { ops: [], rejected: [] };
		});

		// Run sync and API concurrently
		const syncPromise = syncCycle();
		const apiResults = await fireConcurrentRequests(`${baseUrl}/api/stats`, 500);
		await syncPromise;

		reportMetrics("500x during sync", apiResults);

		const successes = apiResults.filter(r => r.status === 200);
		expect(successes).toHaveLength(500);
		expect(percentile(apiResults.map(r => r.latencyMs), 95)).toBeLessThan(1000);
	}, 20000);

	test("should sustain throughput across 5 sequential bursts (no GC degradation)", async () => {
		const burstResults: Array<{ burst: number; avgMs: number; successRate: number }> = [];

		for (let burst = 0; burst < 5; burst++) {
			const results = await fireConcurrentRequests(`${baseUrl}/api/stats`, 200);
			const successes = results.filter(r => r.status === 200);
			const avgMs = results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;

			burstResults.push({
				burst,
				avgMs,
				successRate: successes.length / results.length,
			});
		}

		console.log("  Burst results:");
		for (const br of burstResults) {
			console.log(`    Burst ${br.burst}: avg=${br.avgMs.toFixed(1)}ms rate=${(br.successRate * 100).toFixed(0)}%`);
		}

		// ALL bursts must have 100% success
		for (const br of burstResults) {
			expect(br.successRate).toBe(1);
		}

		// No significant degradation: last burst within 3x of first + tolerance
		const firstAvg = burstResults[0]!.avgMs;
		const lastAvg = burstResults[4]!.avgMs;
		expect(lastAvg).toBeLessThan(firstAvg * 3 + 50);
	}, 30000);

	test("should handle 2000 requests total across different loads", async () => {
		// Phase 1: 500 requests during idle
		const idle = await fireConcurrentRequests(`${baseUrl}/api/health`, 500);

		// Phase 2: 500 requests during sync
		trackedLastBlock = 1000;
		mockGetBlockchainHead.mockResolvedValue({ headBlock: 3000, irreversibleBlock: 3000 });
		mockGetHafAHBlockRange.mockReturnValue(2000);
		mockGetCustomJsonInRange.mockImplementation(async () => {
			await new Promise(r => setTimeout(r, 20));
			return [];
		});
		mockParseHafAHOperations.mockImplementation((): ParseResult => ({ ops: [], rejected: [] }));

		const syncPromise = syncCycle();
		const underLoad = await fireConcurrentRequests(`${baseUrl}/api/health`, 500);
		await syncPromise;

		// Phase 3: 500 requests post-sync
		const postSync = await fireConcurrentRequests(`${baseUrl}/api/health`, 500);

		// Phase 4: final mixed burst
		const finalBurst = await fireConcurrentRequests(`${baseUrl}/api/stats`, 500);

		reportMetrics("Phase 1 (idle)", idle);
		reportMetrics("Phase 2 (sync)", underLoad);
		reportMetrics("Phase 3 (post)", postSync);
		reportMetrics("Phase 4 (final)", finalBurst);

		// ALL phases must have 100% success
		expect(idle.filter(r => r.status === 200)).toHaveLength(500);
		expect(underLoad.filter(r => r.status === 200)).toHaveLength(500);
		expect(postSync.filter(r => r.status === 200)).toHaveLength(500);
		expect(finalBurst.filter(r => r.status === 200)).toHaveLength(500);
	}, 30000);
});

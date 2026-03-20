import { Elysia } from "elysia";
import { getLastBlock, getSyncStatus } from "@/db/queries/sync.ts";
import { getHeadBlockNum } from "@/scanner/hive-client.ts";
import { getProtocolStats } from "@/db/queries/stats.ts";

const STALE_THRESHOLD_MS = 60_000; // 1 minute without processing = stale

export const statusRoutes = new Elysia({ tags: ["Status"] })
	.get("/api/status", async () => {
		const [lastBlock, headBlock] = await Promise.all([
			getLastBlock(),
			getHeadBlockNum().catch(() => 0),
		]);
		return {
			lastBlock,
			headBlock,
			blocksBehind: Math.max(0, headBlock - lastBlock),
			syncing: headBlock - lastBlock > 10,
		};
	}, {
		detail: {
			summary: "Sync status",
			description: "Current indexer sync progress and block height",
		},
	})
	.get("/api/health", async ({ set }) => {
		try {
			const [sync, headBlock] = await Promise.all([
				getSyncStatus(),
				getHeadBlockNum().catch(() => 0),
			]);

			const now = Date.now();
			const lastUpdateMs = sync.updatedAt ? sync.updatedAt.getTime() : 0;
			const secondsSinceUpdate = Math.floor((now - lastUpdateMs) / 1000);
			const blocksBehind = Math.max(0, headBlock - sync.lastBlock);

			const dbAlive = sync.lastBlock > 0;
			const syncActive = secondsSinceUpdate < STALE_THRESHOLD_MS / 1000;
			const inSync = blocksBehind < 100;
			const healthy = dbAlive && syncActive;

			if (!healthy) {
				set.status = 503;
			}

			return {
				status: healthy ? "healthy" : "unhealthy",
				db: dbAlive ? "ok" : "unreachable",
				sync: syncActive ? "active" : "stale",
				inSync,
				lastBlock: sync.lastBlock,
				headBlock,
				blocksBehind,
				secondsSinceUpdate,
			};
		} catch {
			set.status = 503;
			return { status: "unhealthy", db: "unreachable", sync: "unknown" };
		}
	}, {
		detail: {
			summary: "Health check (sync-aware)",
			description: "Returns 200 if DB is reachable and sync processed a block within the last 60s. Returns 503 otherwise. Use for Docker HEALTHCHECK / load balancer probes.",
		},
	})
	.get("/api/stats", async () => {
		return getProtocolStats();
	}, {
		detail: {
			summary: "Protocol statistics",
			description: "Aggregate counts: collections, NFTs, sales, offers, etc.",
		},
	});

import { Elysia, t } from "elysia";
import { getLastBlock, getSyncStatus, getOperationStatus } from "@/db/queries/sync.ts";
import { getHeadBlockNum } from "@/scanner/hive-client.ts";
import { getProtocolStats } from "@/db/queries/stats.ts";
import { getStartupTime } from "@/scanner/sync-state.ts";
import { config } from "@/config.ts";
import {
	PROTOCOL_VERSION,
	PROTOCOL_FEE_PCT,
	MAX_ROYALTY_PCT,
	SUPPORTED_CURRENCIES,
} from "nftlox-sdk";

const STALE_THRESHOLD_MS = 60_000; // 1 minute without processing = stale
const SYNC_TOLERANCE = 10; // blocks behind threshold to consider "in sync"

export const statusRoutes = new Elysia({ tags: ["Status"] })
	.get("/api/status", async () => {
		const [lastBlock, headBlock] = await Promise.all([
			getLastBlock(),
			getHeadBlockNum().catch(() => 0),
		]);
		const blocksBehind = Math.max(0, headBlock - lastBlock);
		const inSync = blocksBehind <= SYNC_TOLERANCE;
		return {
			protocolVersion: PROTOCOL_VERSION,
			protocolId: config.protocolId,
			genesisBlock: config.genesisBlock,
			nodeAccount: config.hiveAccount,
			nodeUrl: config.nodeUrl || null,
			multisigEnabled: !!config.activeKey,
			protocolFee: PROTOCOL_FEE_PCT,
			maxRoyalty: MAX_ROYALTY_PCT,
			supportedCurrencies: SUPPORTED_CURRENCIES,
			lastBlock,
			headBlock,
			blocksBehind,
			inSync,
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
			const startupTime = getStartupTime();
			const isApiRole = config.indexerRole === "api";
			const updatedAfterStartup = isApiRole ? true : (startupTime > 0 && lastUpdateMs > startupTime);
			const syncActive = secondsSinceUpdate < STALE_THRESHOLD_MS / 1000 && updatedAfterStartup;
			const hiveReachable = headBlock > 0;
			const inSync = hiveReachable && blocksBehind <= SYNC_TOLERANCE;
			const healthy = dbAlive && (syncActive || inSync);

			if (!healthy) {
				set.status = 503;
			}

			return {
				status: healthy ? "healthy" : "unhealthy",
				db: dbAlive ? "ok" : "unreachable",
				hive: hiveReachable ? "ok" : "unreachable",
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
			description: "Aggregate counts: collections, NFTs, sales, etc.",
		},
	})
	.get("/api/operation-status/:txId", async ({ params }) => {
		const entries = await getOperationStatus(params.txId);
		return { txId: params.txId, operations: entries };
	}, {
		params: t.Object({ txId: t.String({ minLength: 40, maxLength: 40 }) }),
		detail: {
			summary: "Operation status by transaction ID",
			description: "Returns per-operation status for all protocol operations in a Hive transaction. A single tx can contain multiple custom_json ops, each tracked independently.",
		},
	})

import { Elysia, t } from "elysia";
import { getLastBlock, getSyncStatus, getOperationStatus } from "@/db/queries/sync.ts";
import { getBlockchainHead } from "@/scanner/hive-client.ts";
import { getProtocolStats } from "@/db/queries/stats.ts";
import { getStartupTime } from "@/scanner/sync-state.ts";
import { config } from "@/config.ts";
import { isBeekeeperReady } from "@/api/services/beekeeper-signer.ts";
import {
	PROTOCOL_VERSION,
	PROTOCOL_FEE_PCT,
	MAX_ROYALTY_PCT,
	SUPPORTED_CURRENCIES,
	ALL_ACTIONS,
} from "@/protocol/index.ts";

const STALE_THRESHOLD_MS = 60_000; // 1 minute without processing = stale

export const statusRoutes = new Elysia({ tags: ["Status"] })
	.get("/api/status", async () => {
		const [lastBlock, chain] = await Promise.all([
			getLastBlock(),
			getBlockchainHead().catch(() => ({ headBlock: 0, irreversibleBlock: 0 })),
		]);
		const blocksBehind = Math.max(0, chain.irreversibleBlock - lastBlock);
		const inSync = chain.irreversibleBlock > 0 && lastBlock >= chain.irreversibleBlock;
		return {
			protocolVersion: PROTOCOL_VERSION,
			protocolId: config.protocolId,
			genesisBlock: config.genesisBlock,
			nodeAccount: config.hiveAccount,
			nodeUrl: config.nodeUrl || null,
			multisigEnabled: isBeekeeperReady(),
			protocolFee: PROTOCOL_FEE_PCT,
			maxRoyalty: MAX_ROYALTY_PCT,
			supportedCurrencies: SUPPORTED_CURRENCIES,
			lastBlock,
			headBlock: chain.headBlock,
			irreversibleBlock: chain.irreversibleBlock,
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
			const [sync, chain] = await Promise.all([
				getSyncStatus(),
				getBlockchainHead().catch(() => ({ headBlock: 0, irreversibleBlock: 0 })),
			]);

			const now = Date.now();
			const lastUpdateMs = sync.updatedAt ? sync.updatedAt.getTime() : 0;
			const secondsSinceUpdate = Math.floor((now - lastUpdateMs) / 1000);
			const blocksBehind = Math.max(0, chain.irreversibleBlock - sync.lastBlock);

			const dbAlive = true;
			const startupTime = getStartupTime();
			const isApiRole = config.indexerRole === "api";
			const updatedAfterStartup = isApiRole ? true : (startupTime > 0 && lastUpdateMs > startupTime);
			const syncActive = secondsSinceUpdate < STALE_THRESHOLD_MS / 1000 && updatedAfterStartup;
			const hiveReachable = chain.irreversibleBlock > 0;
			const inSync = hiveReachable && sync.lastBlock >= chain.irreversibleBlock;
			const healthy = dbAlive && hiveReachable && inSync;
			const syncState = inSync ? "ready" : (syncActive ? "catching-up" : "stale");

			if (!healthy) {
				set.status = 503;
			}

			return {
				status: healthy ? "healthy" : "unhealthy",
				db: dbAlive ? "ok" : "unreachable",
				hive: hiveReachable ? "ok" : "unreachable",
				sync: syncState,
				syncActive,
				inSync,
				lastBlock: sync.lastBlock,
				headBlock: chain.headBlock,
				irreversibleBlock: chain.irreversibleBlock,
				blocksBehind,
				secondsSinceUpdate,
			};
		} catch {
			set.status = 503;
			return { status: "unhealthy", db: "unreachable", sync: "unknown" };
		}
	}, {
		detail: {
			summary: "Health check (readiness)",
			description: "Returns 200 only when DB is reachable, Hive is reachable, and the indexer has caught up to the latest irreversible block. Returns 503 otherwise. Use for Docker HEALTHCHECK / load balancer readiness probes.",
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
	.get("/api/operation-status/:txId", async ({ params, query }) => {
		const entries = await getOperationStatus(params.txId);
		const filtered = entries.filter(e =>
			(!query.operationId || e.operationId === query.operationId)
			&& (!query.action || e.action === query.action),
		);
		return { txId: params.txId, operations: filtered };
	}, {
		params: t.Object({ txId: t.String({ minLength: 40, maxLength: 40 }) }),
		query: t.Object({
			operationId: t.Optional(t.String()),
			action: t.Optional(t.String({ enum: [...ALL_ACTIONS] })),
		}),
		detail: {
			summary: "Operation status by transaction ID",
			description: "Returns per-operation status for all protocol operations in a Hive transaction. A single tx can contain multiple custom_json ops, each tracked independently. Use ?operationId= or ?action= to filter.",
		},
	})

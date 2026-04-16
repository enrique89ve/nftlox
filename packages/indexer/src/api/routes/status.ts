import { Elysia, t } from "elysia";
import { getPriceStatus } from "@/utils/fee-oracle.ts";
import { getLastBlock, getSyncStatus, getOperationStatus } from "@/db/queries/sync.ts";
import { getBlockchainHead } from "@/scanner/hive-client.ts";
import { getProtocolStats } from "@/db/queries/stats.ts";
import { getStartupTime } from "@/scanner/sync-state.ts";
import { SYNC_TOLERANCE_BLOCKS } from "@/scanner/sync-engine.ts";
import { config } from "@/config.ts";
import { getMultisigHealth } from "@/api/services/multisig-health.ts";
import {
	evaluateSyncHealth,
	isHealthyForMode,
	type SyncHealthMode,
} from "@/health/sync-health.ts";
import {
	PROTOCOL_VERSION,
	PROTOCOL_FEE_BPS,
	MAX_ROYALTY_PCT,
	SUPPORTED_CURRENCIES,
	ALL_ACTIONS,
	PROTOCOL_GENESIS_BLOCK,
	percentageToBasisPoints,
} from "@/protocol/index.ts";

type ApiHealthBody = Readonly<{
	mode: SyncHealthMode;
	status: "healthy" | "unhealthy";
	db: "ok" | "unreachable";
	hive: "ok" | "unreachable";
	sync: "starting" | "catching-up" | "ready" | "stale" | "unreachable";
	syncActive: boolean;
	inSync: boolean;
	lastBlock: number;
	headBlock: number;
	irreversibleBlock: number;
	blocksBehind: number;
	secondsSinceUpdate: number | null;
}>;

type AggregatedHealthBody = Readonly<{
	status: "healthy" | "unhealthy";
	liveness: ApiHealthBody;
	readiness: ApiHealthBody;
}>;

function buildUnavailableHealthBody(mode: SyncHealthMode): ApiHealthBody {
	return {
		mode,
		status: "unhealthy",
		db: "unreachable",
		hive: "unreachable",
		sync: "unreachable",
		syncActive: false,
		inSync: false,
		lastBlock: 0,
		headBlock: 0,
		irreversibleBlock: 0,
		blocksBehind: 0,
		secondsSinceUpdate: null,
	};
}

async function buildApiHealthBody(mode: SyncHealthMode): Promise<ApiHealthBody> {
	const [sync, chain] = await Promise.all([
		getSyncStatus(),
		getBlockchainHead().catch(() => ({ headBlock: 0, irreversibleBlock: 0 })),
	]);
	const health = evaluateSyncHealth({
		nowMs: Date.now(),
		startupTimeMs: getStartupTime(),
		lastUpdateTimeMs: sync.updatedAt?.getTime() ?? 0,
		lastBlock: sync.lastBlock,
		headBlock: chain.headBlock,
		irreversibleBlock: chain.irreversibleBlock,
		toleranceBlocks: SYNC_TOLERANCE_BLOCKS,
	});
	const healthy = isHealthyForMode(mode, health);
	return {
		mode,
		status: healthy ? "healthy" : "unhealthy",
		db: "ok",
		hive: health.hiveReachable ? "ok" : "unreachable",
		sync: health.syncState,
		syncActive: health.syncActive,
		inSync: health.inSync,
		lastBlock: health.lastBlock,
		headBlock: health.headBlock,
		irreversibleBlock: health.irreversibleBlock,
		blocksBehind: health.blocksBehind,
		secondsSinceUpdate: health.secondsSinceUpdate,
	};
}

async function buildAggregatedHealthBody(): Promise<AggregatedHealthBody> {
	const [liveness, readiness] = await Promise.all([
		buildApiHealthBody("liveness"),
		buildApiHealthBody("readiness"),
	]);
	return {
		status: liveness.status,
		liveness,
		readiness,
	};
}

export const statusRoutes = new Elysia({ tags: ["Status"] })
	.get("/api/status", async () => {
		const [lastBlock, chain] = await Promise.all([
			getLastBlock(),
			getBlockchainHead().catch(() => ({ headBlock: 0, irreversibleBlock: 0 })),
		]);
		const multisig = getMultisigHealth();
		const blocksBehind = Math.max(0, chain.irreversibleBlock - lastBlock);
		const inSync = chain.irreversibleBlock > 0 && blocksBehind <= SYNC_TOLERANCE_BLOCKS;
		return {
			protocolVersion: PROTOCOL_VERSION,
			protocolId: config.protocolId,
			genesisBlock: PROTOCOL_GENESIS_BLOCK,
			nodeAccount: config.hiveAccount,
			nodeUrl: config.nodeUrl || null,
			multisigEnabled: multisig.multisigEnabled,
			multisigSignerReady: multisig.multisigSignerReady,
			multisigClockDriftOk: multisig.multisigClockDriftOk,
			multisigClockDriftMs: multisig.multisigClockDriftMs,
			protocolFeeBps: PROTOCOL_FEE_BPS,
			maxRoyaltyBps: percentageToBasisPoints(MAX_ROYALTY_PCT),
			supportedCurrencies: SUPPORTED_CURRENCIES,
			priceFeed: getPriceStatus(),
			lastBlock,
			headBlock: chain.headBlock,
			irreversibleBlock: chain.irreversibleBlock,
			blocksBehind,
			inSync,
		};
	}, {
		detail: {
			summary: "Sync status",
			description: "Current indexer sync progress and protocol constants. Block fields are Hive block numbers. multisigClockDriftMs is expressed in milliseconds. protocolFeeBps and maxRoyaltyBps use basis points (100 = 1%, 5000 = 50%). priceFeed.hbdPerHive and priceFeed.toleranceBps let bots compute hiveAmount = hbdTarget / hbdPerHive and pad by toleranceBps/10000 before signing.",
		},
	})
	.get("/api/health", async ({ set }) => {
		try {
			const body = await buildAggregatedHealthBody();
			if (body.status !== "healthy") {
				set.status = 503;
			}
			return body;
		} catch {
			set.status = 503;
			return {
				status: "unhealthy",
				liveness: buildUnavailableHealthBody("liveness"),
				readiness: buildUnavailableHealthBody("readiness"),
			};
		}
	}, {
		detail: {
			summary: "Combined health check",
			description: "Returns aggregated liveness and readiness information. The HTTP status follows liveness, while the response body contains both checks.",
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
		return getOperationStatus(params.txId, query.operationId, query.action);
	}, {
		params: t.Object({ txId: t.String({ minLength: 40, maxLength: 40, pattern: "^[a-f0-9]{40}$" }) }),
		query: t.Object({
			operationId: t.Optional(t.String({ description: "Filter by specific operation ID" })),
			action: t.Optional(t.String({ enum: [...ALL_ACTIONS], description: "Filter by protocol action" })),
		}),
		detail: {
			summary: "Operation status by transaction ID",
			description: "Returns per-operation status for all protocol operations in a Hive transaction. Includes NFT IDs for bounded per-NFT operations; bulk creation operations may return an empty ID list. A single tx can contain multiple custom_json ops, each tracked independently.",
		},
	})
	;

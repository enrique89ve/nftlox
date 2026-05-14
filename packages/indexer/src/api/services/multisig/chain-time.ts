import type { Queryable } from "@/db/client.ts";
import { getChainTimeSnapshot } from "@/db/queries/sync.ts";
import {
	CHAIN_TIME_RETRY_AFTER_MS,
	resolveHiveHeadTimeMs,
	type ChainReferenceTimeFailureReason,
	type ChainTimeSnapshot,
} from "@/utils/chain-time.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";
import {
	BUY_API_HEAD_STALENESS_MAX_MS,
	BUY_API_LAG_MAX_BLOCKS,
	HIVE_BLOCK_TIME_MS,
} from "@/protocol/index.ts";

const CHAIN_TIME_FAILURE_MESSAGES: Record<ChainReferenceTimeFailureReason, string> = {
	missing_snapshot: "chain time snapshot is missing",
	invalid_block_numbers: "sync_state has invalid block numbers",
	missing_head_time: "sync_state has no Hive HEAD timestamp yet",
	invalid_head_time: "sync_state Hive HEAD timestamp is invalid",
};

export function requireMultisigChainReferenceTimeMs(snapshot: ChainTimeSnapshot): number {
	const result = resolveHiveHeadTimeMs(snapshot);
	if (result.ok) return result.referenceTimeMs;

	throw createMultisigError(
		"INDEXER_LAGGED",
		`Indexer chain time unavailable: ${CHAIN_TIME_FAILURE_MESSAGES[result.reason]}. Retry shortly.`,
		{ retryAfterMs: CHAIN_TIME_RETRY_AFTER_MS },
	);
}

export function assertMultisigSyncHealthy(
	snapshot: ChainTimeSnapshot,
	nowMs: number = Date.now(),
): void {
	if (
		!Number.isFinite(snapshot.lastBlock)
		|| !Number.isFinite(snapshot.hiveHeadBlock)
		|| !Number.isFinite(snapshot.hiveIrreversibleBlock)
	) {
		throw createMultisigError("INTERNAL_ERROR", "sync_state row has invalid block numbers");
	}

	// Gate (a): processing backlog. Compare against irreversible (not HEAD)
	// because sync intentionally lags HEAD by ~15 blocks of finality —
	// using HEAD here would make the gate structurally unsatisfiable.
	const processingLag = snapshot.hiveIrreversibleBlock - snapshot.lastBlock;
	if (processingLag > BUY_API_LAG_MAX_BLOCKS) {
		const deficit = Math.max(1, processingLag - BUY_API_LAG_MAX_BLOCKS + 1);
		const retryAfterMs = deficit * HIVE_BLOCK_TIME_MS;
		throw createMultisigError(
			"INDEXER_LAGGED",
			`Indexer is ${processingLag} blocks behind last irreversible (max ${BUY_API_LAG_MAX_BLOCKS}); retry in ~${retryAfterMs}ms`,
			{ retryAfterMs },
		);
	}

	// Gate (b): wall-clock staleness. Catches Hive RPC outage where both
	// hive_head_block and hive_irreversible_block freeze together (so the
	// processing-lag gate stays healthy) but our chain-time reference
	// silently rots. A buy tx co-signed against a stale reference time would
	// carry an `expiration` window the witnesses reject — or worse, would be
	// included against a chain that has moved on past the listing snapshot
	// we validated against.
	if (snapshot.hiveHeadTime) {
		const headTimeMs = Date.parse(snapshot.hiveHeadTime);
		if (Number.isFinite(headTimeMs)) {
			const staleness = nowMs - headTimeMs;
			if (staleness > BUY_API_HEAD_STALENESS_MAX_MS) {
				throw createMultisigError(
					"INDEXER_LAGGED",
					`Indexer's Hive HEAD timestamp is ${staleness}ms stale (max ${BUY_API_HEAD_STALENESS_MAX_MS}ms); Hive RPC likely unreachable`,
					{ retryAfterMs: HIVE_BLOCK_TIME_MS },
				);
			}
		}
	}
}

export function getMultisigSigningEvaluationBlock(snapshot: ChainTimeSnapshot): number {
	return snapshot.hiveHeadBlock + BUY_API_LAG_MAX_BLOCKS;
}

export async function readRequiredMultisigChainReferenceTimeMs(
	db: Queryable,
): Promise<number> {
	const snapshot = await getChainTimeSnapshot(db);
	assertMultisigSyncHealthy(snapshot);
	return requireMultisigChainReferenceTimeMs(snapshot);
}

export type MultisigChainReference = Readonly<{
	readonly lastBlock: number;
	readonly referenceTimeMs: number;
	readonly hiveHeadBlock: number;
	readonly signingEvaluationBlock: number;
}>;

// Reads the chain snapshot once and exposes both the Hive HEAD reference time
// (for transaction expiration gating) AND its view of HEAD block (for handler-
// parity consensus-param lookups via @nftlox/protocol's getLimit). Callers
// that need both must use this — splitting the read into two snapshot fetches
// would race a hardfork boundary, picking different LIMIT_SCHEDULE entries
// for the same request.
export async function readRequiredMultisigChainReference(
	db: Queryable,
): Promise<MultisigChainReference> {
	const snapshot = await getChainTimeSnapshot(db);
	assertMultisigSyncHealthy(snapshot);
	const referenceTimeMs = requireMultisigChainReferenceTimeMs(snapshot);
	return {
		lastBlock: snapshot.lastBlock,
		referenceTimeMs,
		hiveHeadBlock: snapshot.hiveHeadBlock,
		signingEvaluationBlock: getMultisigSigningEvaluationBlock(snapshot),
	};
}

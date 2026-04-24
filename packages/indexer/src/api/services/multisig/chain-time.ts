import type { Queryable } from "@/db/client.ts";
import { getChainTimeSnapshot } from "@/db/queries/sync.ts";
import {
	CHAIN_TIME_RETRY_AFTER_MS,
	resolveChainReferenceTimeMs,
	type ChainReferenceTimeFailureReason,
	type ChainTimeSnapshot,
} from "@/utils/chain-time.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";

const CHAIN_TIME_FAILURE_MESSAGES: Record<ChainReferenceTimeFailureReason, string> = {
	missing_snapshot: "chain time snapshot is missing",
	invalid_block_numbers: "sync_state has invalid block numbers",
	missing_head_time: "sync_state has no Hive HEAD timestamp yet",
	invalid_head_time: "sync_state Hive HEAD timestamp is invalid",
};

export function requireMultisigChainReferenceTimeMs(snapshot: ChainTimeSnapshot): number {
	const result = resolveChainReferenceTimeMs(snapshot);
	if (result.ok) return result.referenceTimeMs;

	throw createMultisigError(
		"INDEXER_LAGGED",
		`Indexer chain time unavailable: ${CHAIN_TIME_FAILURE_MESSAGES[result.reason]}. Retry shortly.`,
		{ retryAfterMs: CHAIN_TIME_RETRY_AFTER_MS },
	);
}

export async function readRequiredMultisigChainReferenceTimeMs(
	db: Queryable,
): Promise<number> {
	const snapshot = await getChainTimeSnapshot(db);
	return requireMultisigChainReferenceTimeMs(snapshot);
}

import { HIVE_BLOCK_TIME_MS } from "@/protocol/index.ts";

export const CHAIN_TIME_RETRY_AFTER_MS = HIVE_BLOCK_TIME_MS;

export type ChainTimeSnapshot = Readonly<{
	readonly lastBlock: number;
	readonly hiveHeadBlock: number;
	readonly hiveIrreversibleBlock: number;
	readonly hiveHeadTime: string | null;
}>;

export type ChainReferenceTimeFailureReason =
	| "missing_snapshot"
	| "invalid_block_numbers"
	| "missing_head_time"
	| "invalid_head_time";

export type ChainReferenceTimeResult =
	| Readonly<{ readonly ok: true; readonly referenceTimeMs: number }>
	| Readonly<{ readonly ok: false; readonly reason: ChainReferenceTimeFailureReason }>;

export function resolveChainReferenceTimeMs(
	snapshot: ChainTimeSnapshot | null | undefined,
): ChainReferenceTimeResult {
	if (!snapshot) return { ok: false, reason: "missing_snapshot" };
	if (!Number.isFinite(snapshot.lastBlock) || !Number.isFinite(snapshot.hiveHeadBlock)) {
		return { ok: false, reason: "invalid_block_numbers" };
	}
	if (!snapshot.hiveHeadTime) return { ok: false, reason: "missing_head_time" };

	const headTimeMs = Date.parse(snapshot.hiveHeadTime);
	if (Number.isNaN(headTimeMs)) return { ok: false, reason: "invalid_head_time" };

	const lagBlocks = Math.max(0, snapshot.hiveHeadBlock - snapshot.lastBlock);
	return {
		ok: true,
		referenceTimeMs: headTimeMs - lagBlocks * HIVE_BLOCK_TIME_MS,
	};
}

export function estimateIndexedChainTimeMs(
	snapshot: ChainTimeSnapshot,
): number | null {
	const result = resolveChainReferenceTimeMs(snapshot);
	return result.ok ? result.referenceTimeMs : null;
}

export function selectChainReferenceTimeMs(
	snapshot: ChainTimeSnapshot | null | undefined,
	fallbackNowMs: number = Date.now(),
): number {
	if (!snapshot) return fallbackNowMs;
	return estimateIndexedChainTimeMs(snapshot) ?? fallbackNowMs;
}

// Per-creator action caps — thin wrapper over the protocol's pure
// block-height-indexed getter. The cap values themselves live in
// @nftlox/protocol so a second indexer implementation can mirror them.
//
// See packages/protocol/src/limits.ts for the schedule and hardfork
// discipline. Do NOT introduce a runtime-mutable provider here — that would
// re-create the consensus footgun this module was rewritten to remove.

import { getLimit, type LimitDimension } from "@/protocol/index.ts";

export type { LimitDimension };

/**
 * Asserts that adding `increment` items would not exceed the protocol-coded
 * limit for `dimension` at `blockNum`. Throws if it would.
 *
 * `increment` defaults to 1 for single-item operations (mint). Batch
 * operations (bulk_distribute) pass the planned quantity so the check is
 * applied once against the aggregate, not per-item.
 *
 * A limit of 0 means unlimited (no entry in the current schedule uses 0,
 * but the contract permits it for future hardforks).
 */
export function assertWithinLimit(
	dimension: LimitDimension,
	scopeKey: string,
	currentCount: number,
	blockNum: number,
	increment = 1,
): void {
	const max = getLimit(dimension, blockNum);
	if (max > 0 && currentCount + increment > max) {
		throw new Error(
			`Limit reached for ${dimension} (${scopeKey}): ${currentCount + increment}/${max}`,
		);
	}
}

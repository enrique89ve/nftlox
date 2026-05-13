// NFTLox Protocol — per-creator action caps.
//
// These caps are CONSENSUS parameters: handlers read them to decide accept
// vs reject for create_collection, mint, and bulk_distribute. Two indexer
// implementations disagreeing on a cap produces divergent state roots for
// the same on-chain history.
//
// Therefore: caps live HERE (in @nftlox/protocol), as a pure function of
// block height. They are NOT configurable at runtime, NOT readable from
// environment, NOT swappable via a provider. A second indexer (Rust/Go)
// derives the same value at every block by mirroring LIMIT_SCHEDULE.
//
// Hardfork discipline: changing a cap value means appending an entry to
// LIMIT_SCHEDULE with a strictly-greater fromBlock. The new entry takes
// effect at that block and forward. Edits to existing entries are FORBIDDEN
// outside a chain-wide reindex — they retroactively rewrite history.

export type LimitDimension =
	| "collectionsPerCreator"
	| "seedsPerCreator"
	| "instancesPerCreator";

type LimitSet = Readonly<Record<LimitDimension, number>>;

type LimitScheduleEntry = {
	readonly fromBlock: number;
	readonly limits: LimitSet;
};

// Genesis schedule. To raise a cap mid-chain, append a new entry with the
// hardfork block as fromBlock — do NOT edit existing entries.
const LIMIT_SCHEDULE: ReadonlyArray<LimitScheduleEntry> = [
	{
		fromBlock: 0,
		limits: {
			collectionsPerCreator: 50,
			seedsPerCreator: 3_000,
			instancesPerCreator: 3_000_000,
		},
	},
];

/**
 * Returns the cap for `dimension` active at `blockNum`. Pure function of the
 * schedule — same input always returns the same output, in every indexer
 * implementation, in every process.
 *
 * A cap of `0` means unlimited; callers that pass-through 0 must accept it.
 */
export function getLimit(dimension: LimitDimension, blockNum: number): number {
	if (!Number.isInteger(blockNum) || blockNum < 0) {
		throw new Error(`getLimit: blockNum must be a non-negative integer, got ${blockNum}`);
	}
	// Linear scan from the end — the most recent fork at or before blockNum
	// wins. Schedule length stays small (one entry per hardfork over the
	// chain's lifetime), so O(n) is fine.
	for (let i = LIMIT_SCHEDULE.length - 1; i >= 0; i--) {
		const entry = LIMIT_SCHEDULE[i]!;
		if (entry.fromBlock <= blockNum) return entry.limits[dimension];
	}
	// Unreachable: LIMIT_SCHEDULE always has a `fromBlock: 0` entry. Throw
	// loud rather than return a sentinel so any future bug in the schedule
	// shape surfaces immediately.
	throw new Error(`getLimit: no schedule entry covers blockNum ${blockNum}`);
}

// NFTLox SDK — Seed Availability Helper
// Computes remaining supply from seed fields.
//
// The DB stores `supply_exhausted` as a boolean for fast queries.
// This helper adds the computed `remaining` count for display purposes.
//
//   const nft = await indexer.getNft(seedId);
//   if (nft.supply_exhausted) { /* fast boolean check */ }
//   const avail = computeSeedAvailability(nft);
//   console.log(`${avail.remaining} left of ${avail.maxSupply}`);

type SeedLike = {
	max_supply: number;
	distributed: number;
};

export type SeedAvailability = {
	maxSupply: number;
	distributed: number;
	remaining: number;
	exhausted: boolean;
	unlimited: boolean;
};

export function computeSeedAvailability(seed: SeedLike): SeedAvailability {
	const maxSupply = seed.max_supply;
	const distributed = seed.distributed;
	const unlimited = maxSupply === 0;
	const remaining = unlimited ? Infinity : Math.max(0, maxSupply - distributed);
	const exhausted = !unlimited && distributed >= maxSupply;

	return { maxSupply, distributed, remaining, exhausted, unlimited };
}

// Shape returned by the indexer seed endpoints (`GET /api/nfts/:id` for a seed,
// or any listing response that includes `max_supply`, `distributed`, and
// `tx_id`). Only the fields the packs-engine needs are required.
export type IndexerSeedLike = {
	id: string;
	max_supply: number;
	distributed: number;
	tx_id: string;
};

// Matches `SeedSupplySnapshot` in `nftlox-packs-engine`. Duplicated here to
// avoid a hard dependency on the packs-engine package from the SDK — games
// that do not use packs should not need to install it.
export type PackSeedSnapshot = {
	readonly seedId: string;
	readonly seedTxId: string;
	readonly maxSupply: number;
	readonly distributed: number;
	readonly reserved: number;
};

// Maps an indexer seed response to a `SeedSupplySnapshot`. The `reserved`
// field is off-chain bookkeeping owned by the game backend — there is no
// on-chain protocol action that mutates `reserved_supply`, and the public
// indexer API does not expose it. Pass the game's tracked value (default 0).
export function snapshotFromIndexerSeed(
	seed: IndexerSeedLike,
	reserved: number = 0,
): PackSeedSnapshot {
	if (!Number.isInteger(reserved) || reserved < 0) {
		throw new Error("reserved must be a non-negative integer");
	}
	return {
		seedId: seed.id,
		seedTxId: seed.tx_id,
		maxSupply: seed.max_supply,
		distributed: seed.distributed,
		reserved,
	};
}

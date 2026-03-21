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
	max_replicas: number;
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
	const maxSupply = seed.max_replicas;
	const distributed = seed.distributed;
	const unlimited = maxSupply === 0;
	const remaining = unlimited ? Infinity : Math.max(0, maxSupply - distributed);
	const exhausted = !unlimited && distributed >= maxSupply;

	return { maxSupply, distributed, remaining, exhausted, unlimited };
}

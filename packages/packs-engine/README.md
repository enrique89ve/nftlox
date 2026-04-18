# nftlox-packs-engine

> External library for pack definition and distribution planning. Produces a `bulk_distribute` delivery plan consumed by the NFTLox indexer.

Packs are **not** part of the native NFTLox protocol. This package lives outside the protocol surface to keep the core minimal — anyone building a pack-opening flow uses this engine (or rolls their own) on top of `nftlox-sdk`.

## What it does

- Validates pack definitions (drop tables, weights, items per pack).
- Computes reservation demand per seed.
- Resolves deterministic pack openings via a seeded RNG.
- Produces a `bulk_distribute` delivery plan ready to broadcast.

## What it does NOT own

Pack balances, payments, inventory, idempotency persistence, database state, and SPV verification of pack-opening claims. Those concerns belong in an external backend.

## Two contracts every integrator must know

1. **The signer must own every seed in the drop table.**
	`bulk_distribute` is validated by the indexer with `seed.owner === op.signer` for each item (see `packages/indexer/src/processor/handlers/core/bulk-distribute.ts`). A single "pack vault" account (e.g. `game-pack-vault`) must hold all seeds referenced by the pack. If your game splits seed ownership across accounts, you need one pack signer per owning account.

2. **Reservation is off-chain bookkeeping.**
	The indexer stores a `reserved_supply` column on seeds, but **no protocol action mutates it**, and the public API does not expose it. `computeReservedSupply()`, `validateReservationDemand()`, and `plan.reservationConsumption` are advisory — they tell your backend how much supply to reserve internally so two players cannot both drain the same seed. Persist that state in your own database, decrement on successful `bulk_distribute` broadcasts, and release on failure.

## Install

```bash
bun add nftlox-packs-engine
# or
npm install nftlox-packs-engine
# or
pnpm add nftlox-packs-engine
```

External npm consumers also need `nftlox-sdk` available, because the packs engine emits SDK-compatible `bulk_distribute` items.

## Quick start

```typescript
import {
	createPackDefinition,
	buildPackOpenPlan,
	computeReservedSupply,
} from "nftlox-packs-engine";
import { buildBulkDistribute, snapshotFromIndexerSeed } from "nftlox-sdk";

// Define a pack with a drop table
const pack = await createPackDefinition({
	collectionId: "col_abc123",
	name: "Starter Pack",
	itemsPerPack: 5,
	maxSupply: 100,
	dropTable: [
		{ seedId: "seed_common", weight: 70 },
		{ seedId: "seed_rare", weight: 25 },
		{ seedId: "seed_legendary", weight: 5 },
	],
});

// Check how much seed supply needs reserving
const demand = computeReservedSupply(pack);

// Fetch each seed from the indexer API and adapt it to the engine's snapshot
// shape. `reserved` is your backend's own counter — pass 0 if you don't track
// reservations yet.
const seedSnapshots = await Promise.all(
	["seed_common", "seed_rare", "seed_legendary"].map(async (id) => {
		const res = await fetch(`https://api-nftlox.hivecreators.co/api/nfts/${id}`);
		const nft = await res.json();
		return snapshotFromIndexerSeed(nft, myBackend.getReservedFor(id));
	}),
);

// Open a pack — deterministic selection from a blockchain-derived seed
const plan = buildPackOpenPlan({
	definition: pack,
	seedSnapshots,
	context: {
		txId: "d".repeat(40),
		operationId: "pack-open-1",
		blockNum: 90000000,
		owner: "alice",
		quantity: 1,
	},
	reservationAvailabilityBySeed: demand,
});

const distribution = await buildBulkDistribute({
	signer: "game-pack-vault",
	to: "alice",
	items: plan.items,
	mutableData: { source: "starter_pack" },
});

// plan.selections explains every pack opening.
// plan.items is the exact bulk_distribute item list.
// plan.reservationConsumption is what your backend persists after broadcast.
```

## Main exports

| Export | Purpose |
|---|---|
| `createPackDefinition()` | Validate and create a pack definition |
| `assertValidPackDefinition()` | Throws if pack definition is invalid |
| `computeReservedSupply()` | Calculate reservation demand per seed |
| `validateReservationDemand()` | Check if supply meets reservation demand |
| `buildPackOpenPlan()` | Resolve a deterministic pack opening |
| `selectPackSeedIds()` | Low-level seed selection from drop table |
| `buildPackOpenSeed()` | Canonical RNG seed string — useful if you write a custom resolver |
| `generateDeterministicPackId()` | Deterministic pack ID generation |
| `isPackId()` | ID type check |
| `deterministicRng()` | Seeded RNG for reproducible openings |
| `resolveDropTable()` | Resolve weighted drop table to concrete selections |

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `MAX_DROP_TABLE_ENTRIES` | — | Maximum entries in a drop table |
| `MAX_ITEMS_PER_PACK` | — | Maximum items per pack opening |
| `MAX_PACK_OPEN_BATCH` | — | Maximum pack openings in a single batch |
| `MIN_DROP_WEIGHT` / `MAX_DROP_WEIGHT` | — | Weight bounds for drop table entries |

## Compatibility

The package supports **Node.js ≥18 and Bun** — server-side only. `deterministicRng()` uses Node's synchronous `crypto.createHash` for speed inside the selection loop, so the module is not browser-safe. Pack opening is always a backend concern anyway because it needs blockchain-anchored context (`txId`, `blockNum`) that only a server with indexer access can provide.

## Pack metadata

The engine deliberately does **not** model `description`, `imageUrl`, `price`, or other presentation data. Packs are external to the protocol — your backend owns its own pack catalog, UI copy, and pricing. Pass only what the engine needs: `collectionId`, `name`, `dropTable`, `itemsPerPack`, `maxSupply`.

## Documentation

Start with the playground guide: [`packages/playground/docs/guides/game-bot-testing.md`](../playground/docs/guides/game-bot-testing.md).

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build the package |
| `bun run test` | Run all packs-engine tests |

## License

MIT

# @nftlox/packs-engine

> External library for pack definition and distribution planning. Produces a `bulk_distribute` delivery plan consumed by the NFTLox indexer.

Packs are **not** part of the native NFTLox protocol. This package lives outside the protocol surface to keep the core minimal — anyone building a pack-opening flow uses this engine (or rolls their own) on top of `@nftlox/sdk`.

## What it does

- Validates pack definitions (drop tables, weights, items per pack).
- Computes reservation demand per seed.
- Resolves deterministic pack openings via a seeded RNG.
- Produces a `bulk_distribute` delivery plan ready to broadcast.

## What it does NOT own

Pack balances, payments, inventory, idempotency persistence, database state, and SPV verification of pack-opening claims. Those concerns belong in an external backend.

## Install

```bash
bun add @nftlox/packs-engine
```

## Quick start

```typescript
import {
	createPackDefinition,
	buildPackOpenPlan,
	computeReservedSupply,
} from "@nftlox/packs-engine";

// Define a pack with a drop table
const pack = createPackDefinition({
	collectionId: "col_abc123",
	itemsPerPack: 5,
	dropTable: [
		{ seedId: "seed_common", weight: 70 },
		{ seedId: "seed_rare", weight: 25 },
		{ seedId: "seed_legendary", weight: 5 },
	],
});

// Check how much seed supply needs reserving
const demand = computeReservedSupply(pack, { totalPacks: 100 });

// Open a pack — deterministic selection from a blockchain-derived seed
const plan = buildPackOpenPlan({
	packDefinition: pack,
	opener: "alice",
	txId: "abc123...",
	supplySnapshot: [
		{ seedId: "seed_common", available: 500 },
		{ seedId: "seed_rare", available: 200 },
		{ seedId: "seed_legendary", available: 50 },
	],
});
// plan.selections contains the seed IDs to distribute
// plan.consumptions tracks supply decrements
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

Runs on **Node.js** and **Bun** — same constraint as `@nftlox/sdk`.

## Documentation

Pack distribution guide at [`packages/playground/docs/pack-distribution-guide.md`](../playground/docs/pack-distribution-guide.md) (will be moved here in Phase 2 per the audit).

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build the package |
| `bun run test` | Run all packs-engine tests |

## License

MIT

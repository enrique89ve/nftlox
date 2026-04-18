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
import { buildBulkDistribute } from "nftlox-sdk";

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

// Open a pack — deterministic selection from a blockchain-derived seed
const plan = buildPackOpenPlan({
	definition: pack,
	seedSnapshots: [
		{ seedId: "seed_common", seedTxId: "a".repeat(40), maxSupply: 500, distributed: 20, reserved: 100 },
		{ seedId: "seed_rare", seedTxId: "b".repeat(40), maxSupply: 200, distributed: 5, reserved: 40 },
		{ seedId: "seed_legendary", seedTxId: "c".repeat(40), maxSupply: 50, distributed: 0, reserved: 10 },
	],
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

The package supports **Node.js and Bun**. Node.js uses the compiled ESM entry at `dist/index.js`; Bun uses the `bun` export condition and can execute `src/index.ts` directly.

## Documentation

Start with the playground guide: [`packages/playground/docs/guides/game-bot-testing.md`](../playground/docs/guides/game-bot-testing.md).

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build the package |
| `bun run test` | Run all packs-engine tests |

## License

MIT

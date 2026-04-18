# Game Bot Testing

This guide is written for backend bots and LLM agents that need to test a game flow with the SDK: create a collection, mint seed templates, open packs, and distribute seed instances.

## Package Names

Inside this monorepo, run `bun install` at the repository root and import workspace packages directly:

```typescript
import { buildCollectionWithSeeds } from "nftlox-sdk";
import { buildPackOpenPlan } from "nftlox-packs-engine";
```

The package names come from `packages/sdk/package.json` and `packages/packs-engine/package.json`. Once published, external projects will install with `bun add nftlox-sdk nftlox-packs-engine` (or the npm/pnpm equivalent).

> **Testnet phase — one supported install path.** The SDK depends on the workspace package `@nftlox/protocol`, so `bun add file:../nftlox/packages/sdk` from an external repo does not resolve. Until the packages are published, the only clean way to test is to **work inside the monorepo** as a workspace package — see the next section.

## Test the SDK Today

The SDK can be tested now without publishing to npm. The reliable path is to clone the NFTLox repo and run the game bot inside the monorepo, because the SDK currently depends on the workspace package `@nftlox/protocol`.

```bash
git clone https://github.com/enrique89ve/nftlox.git nftlox
cd nftlox
bun install
bun run --filter nftlox-sdk typecheck
bun test packages/sdk/tests/builder-consistency.test.ts packages/sdk/tests/exports.test.ts
```

For a quick import smoke test from the repo root:

```bash
bun --eval 'const { resolveNodeAccountFromStatus } = await import("./packages/sdk/src/index.ts"); console.log(resolveNodeAccountFromStatus({ nodeAccount: "nftlox-node", multisigEnabled: true, multisigSignerReady: true }, { requireMultisigReady: true }));'
```

For a temporary game bot, create a workspace package under `packages/`:

```json
{
	"name": "game-sdk-smoke",
	"private": true,
	"type": "module",
	"scripts": {
		"start": "bun run src/bot.ts"
	},
	"dependencies": {
		"nftlox-sdk": "workspace:*",
		"nftlox-packs-engine": "workspace:*"
	}
}
```

Then create `src/bot.ts` in that temporary package:

```typescript
import { createIndexerClient, buildCollectionWithSeeds } from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

const indexer = createIndexerClient(INDEXER_URL);
const nodeAccount = await indexer.getMultisigNodeAccount();
console.log(`Node co-signer: ${nodeAccount}`);

const plan = await buildCollectionWithSeeds(
	{
		creator: "game-admin",
		name: "Smoke Test Heroes",
		symbol: "SMOKE",
		totalPotential: 10,
		metadata: {
			description: "SDK smoke test collection",
			image: "https://example.com/smoke.png",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct: 0,
		},
		seeds: [
			{
				artId: "hero-smoke-001",
				name: "Smoke Hero",
				imageUrl: "https://example.com/smoke-hero.png",
				maxSupply: 10,
			},
		],
	},
	{
		indexerBaseUrl: INDEXER_URL,
		feeCurrency: "HBD",
		feeAmount: "0.100",
	},
);

if (!plan.success) {
	throw new Error(`Plan failed: ${JSON.stringify(plan.errors)}`);
}

console.log(plan.collectionId);
console.log(plan.collectionStep.coSigners);
console.log(plan.seedBatches);
```

Run it from the repo root:

```bash
bun run --filter game-sdk-smoke start
```

External repositories should wait for npm publication. The `file:` install path is not supported during testnet because `@nftlox/protocol` is a workspace dependency that does not resolve outside the monorepo.

## Test Ladder

Start at the cheapest layer and only move down when the previous layer is deterministic.

| Layer | What to prove | Network |
|---|---|---|
| SDK dry run | Inputs validate, IDs are generated, operations have the right signers; use a mocked status response or explicit `nodeAccount` | No |
| Packs engine dry run | Pack definition, reserved supply, and selection plan are deterministic | No |
| Indexer API build | HTTP payloads match SDK builders | Local or test API |
| Local indexer replay | Broadcasted test transactions produce expected state | Local |
| Hive testnet broadcast | Active/posting/multisig signing works end to end | Yes |

## Node Account for Multisig

The node account is the Hive account that must co-sign node-controlled flows such as `create_collection` and `buy`. A bot should read it from the indexer instead of hardcoding it.

```typescript
import { createIndexerClient, fetchMultisigNodeAccount } from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

const indexer = createIndexerClient(INDEXER_URL);
const nodeAccount = await indexer.getMultisigNodeAccount();

// Equivalent helper when a full client is not needed:
const sameNodeAccount = await fetchMultisigNodeAccount(INDEXER_URL);

console.log({ nodeAccount, sameNodeAccount });
```

For collection creation, pass `indexerBaseUrl` to the SDK. The builder fetches `/api/status`, validates `nodeAccount`, and requires multisig readiness by default.

```typescript
const plan = await buildCollectionWithSeeds(
	collectionWithSeedsInput,
	{
		indexerBaseUrl: INDEXER_URL,
		feeCurrency: "HBD",
		feeAmount: "0.100",
	},
);
```

## Minimal Bot Responsibilities

A reliable game bot owns only orchestration. The protocol and indexer remain the source of truth.

| Bot responsibility | Source of truth |
|---|---|
| Build collection and seed operations | `nftlox-sdk` |
| Sign creator active-key collection transaction | Hive wallet/signing library |
| Request node co-signature | Indexer multisig endpoint via SDK |
| Broadcast collection and seed batches | Hive RPC |
| Capture each seed transaction ID | Hive broadcast result |
| Build pack opening plan | `nftlox-packs-engine` |
| Distribute selected seed instances | `buildBulkDistribute()` |
| Verify final ownership | Indexer read API or SDK SPV helpers |

## Collection and Seeds Plan

```typescript
import { buildCollectionWithSeeds } from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

const collectionPlan = await buildCollectionWithSeeds(
	{
		creator: "game-admin",
		name: "Starter Heroes",
		symbol: "HERO",
		totalPotential: 1000,
		metadata: {
			description: "Playable starter heroes",
			image: "https://example.com/heroes.png",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct: 5,
			royaltyRecipient: "game-treasury",
		},
		schema: {
			immutable: [
				{ name: "hero_class", type: "string" },
				{ name: "rarity", type: "string" },
			],
			mutable: [
				{ name: "level", type: "uint8" },
				{ name: "xp", type: "uint32" },
			],
		},
		seeds: [
			{
				artId: "hero-warrior-001",
				name: "Kael the Brave",
				imageUrl: "https://example.com/heroes/kael.png",
				maxSupply: 500,
				immutableData: {
					hero_class: "warrior",
					rarity: "rare",
				},
			},
			{
				artId: "hero-mage-001",
				name: "Lyra the Arcane",
				imageUrl: "https://example.com/heroes/lyra.png",
				maxSupply: 250,
				immutableData: {
					hero_class: "mage",
					rarity: "epic",
				},
			},
		],
		owner: "game-treasury",
	},
	{
		indexerBaseUrl: INDEXER_URL,
		feeCurrency: "HBD",
		feeAmount: "0.100",
	},
);

if (!collectionPlan.success) {
	throw new Error(`Collection plan failed: ${JSON.stringify(collectionPlan.errors)}`);
}

console.log(collectionPlan.collectionId);
console.log(collectionPlan.collectionStep.coSigners);
console.log(collectionPlan.seedBatches.map((batch) => batch.seeds));
```

The collection step must be signed with the creator active key and co-signed by the node. Seed batches are posting-key operations from the collection creator.

## Capture Seed Transaction IDs

`bulk_distribute` needs each `seedTxId`. A bot must store the transaction ID returned when each seed batch is broadcast. The SDK can precompute `seedId`, but only Hive can provide the final transaction ID.

```typescript
type BroadcastResult = Readonly<{
	txId: string;
	blockNum: number;
}>;

const seedTxIdBySeedId = new Map<string, string>();

for (const batch of collectionPlan.seedBatches) {
	const result: BroadcastResult = await signAndBroadcastPosting(batch.operations);

	for (const seed of batch.seeds) {
		seedTxIdBySeedId.set(seed.seedId, result.txId);
	}
}
```

## Packs Engine Anatomy

Packs are an external game mechanic. They are not a native NFTLox protocol action. The packs engine is a deterministic planner that turns a pack definition and current seed supply snapshots into `bulk_distribute` items.

Two rules the engine itself does not enforce:

- **Signer = seed owner.** The indexer rejects `bulk_distribute` unless `op.signer === seed.owner` for every item. Every seed in the drop table must be owned by the account that signs the distribution (your pack vault).
- **Reservation is off-chain.** No protocol action mutates the indexer's `reserved_supply` column, and the public API does not expose it. `computeReservedSupply()` and `plan.reservationConsumption` are advisory numbers your game backend must persist and decrement in its own database.

| Part | Meaning |
|---|---|
| `PackDefinition` | Collection ID, pack name, drop table, `itemsPerPack`, and `maxSupply`. Presentation metadata (description, image, price) lives in the game's backend, not in the engine. |
| Drop table | Weighted list of `seedId` values that can appear in a pack |
| Reserved supply | Per-seed amount that should be held back for pack openings |
| Seed snapshot | Current `seedId`, `seedTxId`, `maxSupply`, `distributed`, and `reserved` state |
| Open context | Claim transaction ID, operation ID, block number, owner, and quantity |
| Open plan | Deterministic selections plus `bulk_distribute` items |

```typescript
import {
	buildPackOpenPlan,
	computeReservedSupply,
	createPackDefinition,
	validateReservationDemand,
} from "nftlox-packs-engine";
import { buildBulkDistribute, snapshotFromIndexerSeed } from "nftlox-sdk";

const requireSeedId = (artId: string): string => {
	const seedId = collectionPlan.generatedIds[artId];
	if (!seedId) throw new Error(`Missing seed id for ${artId}`);
	return seedId;
};

const warriorSeedId = requireSeedId("hero-warrior-001");
const mageSeedId = requireSeedId("hero-mage-001");

const pack = await createPackDefinition({
	collectionId: collectionPlan.collectionId,
	name: "Starter Pack",
	itemsPerPack: 3,
	maxSupply: 100,
	dropTable: [
		{ seedId: warriorSeedId, weight: 80 },
		{ seedId: mageSeedId, weight: 20 },
	],
});

const reservedSupply = computeReservedSupply(pack);

const requireSeedTxId = (seedId: string): string => {
	const txId = seedTxIdBySeedId.get(seedId);
	if (!txId) throw new Error(`Missing seed tx id for ${seedId}`);
	return txId;
};

// Pull live supply from the indexer and adapt each response to the engine's
// snapshot shape. The `reserved` argument is what YOUR backend has reserved
// internally — there is no on-chain reservation action.
const fetchSeed = async (seedId: string) => {
	const res = await fetch(`${indexerBaseUrl}/nfts/${seedId}`);
	if (!res.ok) throw new Error(`Seed ${seedId} not found on indexer`);
	return res.json() as Promise<{ id: string; max_supply: number; distributed: number; tx_id: string }>;
};

const seedSnapshots = [
	snapshotFromIndexerSeed(await fetchSeed(warriorSeedId), gameBackend.reservedFor(warriorSeedId)),
	snapshotFromIndexerSeed(await fetchSeed(mageSeedId), gameBackend.reservedFor(mageSeedId)),
];

validateReservationDemand(pack, seedSnapshots);

const openPlan = buildPackOpenPlan({
	definition: pack,
	seedSnapshots,
	context: {
		txId: "c".repeat(40),
		operationId: "pack-claim-1",
		blockNum: 90000000,
		owner: "player-alice",
		quantity: 1,
	},
	reservationAvailabilityBySeed: reservedSupply,
});

const distribution = await buildBulkDistribute({
	signer: "game-treasury",
	to: "player-alice",
	items: openPlan.items,
	mutableData: {
		level: 1,
		xp: 0,
		source: "starter_pack",
	},
});

if (!distribution.success) {
	throw new Error(`Distribution failed: ${JSON.stringify(distribution.errors)}`);
}
```

## Fairness Rule for Pack Opening

The randomness seed should come from a player claim or payment transaction that exists before the bot builds the distribution. Do not use the later `bulk_distribute` transaction as the randomness source, because the bot controls when that transaction is created.

Recommended context:

| Field | Recommended value |
|---|---|
| `txId` | Player pack-claim or payment transaction ID |
| `operationId` | Stable ID for the claim operation inside that transaction |
| `blockNum` | Block that anchored the claim |
| `owner` | Player receiving the pack |
| `quantity` | Number of packs opened in this claim |

## End-to-End Bot Checklist

1. Fetch `indexer.getMultisigNodeAccount()` and fail fast if the signer is not ready.
2. Build `collectionPlan` with `indexerBaseUrl`.
3. Sign collection operations with the creator active key.
4. Request node co-signature through `requestCreateCollectionMultisig()`.
5. Broadcast the final collection transaction.
6. Broadcast each seed batch with posting key and persist `seedId -> seedTxId`.
7. Build a pack definition with `nftlox-packs-engine`.
8. Persist reserved supply per seed before selling or opening packs.
9. For each player claim, build `openPlan` from claim tx data and current seed snapshots.
10. Build and broadcast `bulk_distribute` with `openPlan.items`.
11. Persist `reservationConsumption` after broadcast.
12. Query the indexer or run SPV verification to confirm ownership.

## npm Publishing Decision

Publishing is not required to test inside this monorepo. The workspace packages already resolve through Bun workspaces.

Publishing is useful when external game repositories or LLM-generated projects need a simple install flow with Bun, npm, or pnpm. The packages now expose compiled ESM plus `.d.ts` files for Node.js and keep Bun-readable TypeScript source through the `bun` export condition. Before publishing, run package type checks and builds, then publish any dependency that external consumers need.

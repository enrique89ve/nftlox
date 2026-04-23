# Using the SDK

`nftlox-sdk` is a pure TypeScript library with one job: **produce unsigned Hive operations that satisfy the NFTLox protocol**. It has no HTTP server, no hidden key management, no wallet coupling. You sign what it builds; you broadcast from wherever you want.

## Install

> **Testnet phase** — `nftlox-sdk` is not yet published to npm. Clone the monorepo and reference it as a workspace package. See [Game Bot Testing](../guides/game-bot-testing.md) for the full setup.

Once published, the install will be:

```bash
npm install nftlox-sdk hive-tx
# or
bun add nftlox-sdk hive-tx
```

`nftlox-sdk` brings `@nftlox/protocol` as a transitive dependency and re-exports every type, constant, validator, and ID generator. You never need to import the protocol package directly.

Runtime targets: browsers, Node ≥ 18, Bun ≥ 1.0, Deno. Every hashing primitive is `crypto.subtle` — no Node-only APIs.

## The shape of every builder

Every `build*` function returns a `KeychainResult<T>` discriminated union. Three rules:

1. **Narrow on `success` before touching anything else.** Errors are strongly typed (`{ field, message, code }`) and safe to surface directly in a form.
2. **`operations` is ready to sign.** Already in Hive's tuple format `["custom_json", { … }]` / `["transfer", { … }]`. Hand it straight to `hive-tx`, `@hiveio/wax`, or `@hiveio/dhive`.
3. **`keyType` tells you which key.** `"Active"` only for `create_collection` and `buy`; `"Posting"` for everything else.

For the full type definition see [SDK Reference — KeychainResult](reference.md#the-keychainresultt-contract).

## Three signing flows

Every action falls into one of three shapes — recognizing which one changes how you broadcast:

| Flow | Triggered by | Signers |
|---|---|---|
| **Posting, single-signer** | 18 of 20 builders | You, posting key |
| **Node-last buy** | `buildBuy` | You sign the full tx (active); node validates, broadcasts a `buy_commitment`, co-signs, and broadcasts the settled buy via `/api/multisig/buy` |
| **Active + dual-signer** | `buildCollection` | You (active) + node via `/api/multisig/collection` |

For runnable code for each flow with hive-tx, dhive, wax, and Keychain, see [Signing & Broadcasting](../broadcasting.md).

## Pre-computing deterministic IDs

You never need to broadcast to learn what ID an action will produce. Every protocol ID is a domain-separated SHA-256 hash over public inputs:

```typescript
import {
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
} from "nftlox-sdk";

const colId  = await generateDeterministicCollectionId("alice", "Heroes", "HERO");
const seedId = await generateDeterministicSeedId(colId, "warrior");
const nftId  = await generateDeterministicInstanceId(seedId, 1);
```

Use cases:
- **Optimistic UI** — render the deep link before the block confirms.
- **Cross-references** — an immutable_data field can reference an unlaunched collection.
- **Airdrop scripts** — precompute every recipient's instance ID before you broadcast.

`buildCollection`, `buildSeed`, and `buildList` expose computed IDs via `result.generatedIds` — prefer that over re-hashing yourself.

## Schema builder

`createSchemaBuilder()` is a fluent typed builder for `CollectionSchema`. TypeScript enforces that field names are valid identifiers and types are one of the 24 accepted primitives/arrays (`string`, `bool`, `uint8-64`, `int8-64`, `float`, `double`, and `[]` variants).

```typescript
import { createSchemaBuilder } from "nftlox-sdk";

const schema = createSchemaBuilder()
	.immutable("rarity", "string")
	.immutable("base_power", "uint16")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.build();
```

Immutable fields are set at mint time and frozen forever. Mutable fields can be updated with `buildSetData` (owner) or `buildSetDataFrom` (approved operator). Schemas are append-only via `buildExtendSchema`.

## Reading indexed state

`createIndexerClient(baseUrl)` produces a typed `IndexerClient`. All methods are thin wrappers around unauthenticated `GET` endpoints — no keys required.

```typescript
import { createIndexerClient } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");

const status   = await client.getStatus();
const userNfts = await client.getUserNfts("alice", { status: "active", type: "seed" });
const listings = await client.getListings({ sort: "price_asc", currency: "HIVE" });
const nft      = await client.getNft("nft_…");
const proof    = await client.getNftProof("nft_…");

// Wait for a broadcast tx to be indexed:
const opStatus = await client.getOperationStatus(broadcastTxId);
// { indexed, totalOperations, confirmed, invalid, orphaned, operations[] }
```

Inject a custom `fetch` via `createIndexerClient(url, { fetch })` for tests or proxying.

## Bulk launch — `buildCollectionWithSeeds`

One-shot planner for launching a collection and all its seeds. Returns `collectionStep` (dual-signer, active key) and `seedBatches[]` (posting-only, auto-sized below Hive's 8 KiB cap).

See [Seed Ceremony](../use-cases/seed-ceremony.md) for the complete runnable script.

## Transaction sizing primitives

```typescript
import { splitIntoBatches, calculateMaxOperationsPerTx } from "nftlox-sdk";

const perTx   = calculateMaxOperationsPerTx(sampleCustomJson);
const batches = splitIntoBatches(items, Math.min(perTx, MAX_OPERATIONS_PER_TX));
```

Use these when building your own orchestrators (mass airdrops, schema migrations) to get the same sizing guarantees `buildCollectionWithSeeds` uses internally.

## Error handling

```typescript
import { NftloxError, IndexerError, MultisigError } from "nftlox-sdk";

try {
	const sig = await requestBuyMultisig(INDEXER, request);
} catch (err) {
	if (err instanceof MultisigError) {
		// err.code, err.retryAfterMs
	} else if (err instanceof IndexerError) {
		// err.statusCode, err.responseBody, err.url
	}
}
```

All SDK errors extend `NftloxError`. Validation errors never throw — they live inside `result.errors`.

## When to reach for the SDK vs the indexer API

| Need | Use |
|---|---|
| Read protocol state (nfts, listings, stats, proofs) | `createIndexerClient` (GET) |
| Compute a deterministic ID off-line | `generate*` helpers |
| Build a signable Hive operation | `build*` builders |
| Settle a `buy` (node-last) | `client.requestBuyMultisig(…)` or `requestBuyMultisig` |
| Co-sign a `create_collection` | `client.multisig(…)` or `requestCreateCollectionMultisig` |
| Ship a full collection with seeds | `buildCollectionWithSeeds` |

The indexer never has the user's keys. It exposes read endpoints and two narrow co-signing endpoints. Everything else is client-side.

## Next

- [SDK Reference](reference.md) — full type-level inventory of every builder, helper, and constant.
- [Signing & Broadcasting](../broadcasting.md) — runnable signing code for all three flows.
- [Seed Ceremony](../use-cases/seed-ceremony.md) — end-to-end launch script.
- [Data Formats](../data-formats.md) — on-chain payload shape for every action.

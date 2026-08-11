# Getting Started

This guide takes you from zero to a minted NFT on the NFTLox testnet in a single file. Everything runs client-side: the indexer only serves **read** endpoints and the **multisig** co-signing endpoint — it never holds your keys and never builds payloads for you.

The current public-test protocol is `0.11.0`. It is not wire-compatible with
`0.10.x`: custody and delegation operations require the Hive active key.

## Prerequisites

- **Hive account** — create one at [signup.hive.io](https://signup.hive.io)
- **Active key** — required for collection creation, marketplace settlement, and all custody/delegation actions (`transfer`, `list`, `unlist`, approvals, and lending)
- **Posting key** — required for non-custodial supply, data, schema, and node operations (mint, set_data, extend_schema, …)
- **Node.js ≥ 18 or Bun ≥ 1.0** — the SDK uses Web Crypto (`crypto.subtle`), available natively in both
- A Hive signing library of your choice: [`hive-tx`](https://www.npmjs.com/package/hive-tx), [`@hiveio/dhive`](https://www.npmjs.com/package/@hiveio/dhive), or [`@hiveio/wax`](https://www.npmjs.com/package/@hiveio/wax)

Your private keys **never leave your machine**. The SDK emits unsigned operations; you sign them locally.

## Install

> **Testnet phase** — `nftlox-sdk` is not yet published to npm. Clone the monorepo and work inside it as a workspace package.

```bash
git clone https://github.com/enrique89ve/nftlox.git
cd nftlox
bun install
```

Then add your project as a workspace package under `packages/` with `"nftlox-sdk": "workspace:*"` in its `package.json`. See [Game Bot Testing](guides/game-bot-testing.md) for a step-by-step setup.

Once published to npm, the install will be:

```bash
npm install nftlox-sdk hive-tx
# or
bun add nftlox-sdk hive-tx
```

`nftlox-sdk` transitively depends on `@nftlox/protocol` and re-exports everything from it. A single import is enough for every builder, type, constant, and helper.

## The testnet in one request

Verify the indexer is reachable and report the protocol version it is serving:

```bash
curl https://api-nftlox.hivecreators.co/api/status
```

```json
{
	"protocolVersion": "0.11.0",
	"protocolId": "nftlox_testnet",
	"genesisBlock": 12345678,
	"nodeAccount": "nftlox",
	"multisigEnabled": true,
	"multisigSignerReady": true,
	"lastBlock": 98765432,
	"headBlock": 98765435,
	"blocksBehind": 3,
	"inSync": true,
	"protocolFeeBps": 100,
	"maxRoyaltyBps": 5000,
	"supportedCurrencies": ["HIVE", "HBD"]
}
```

Two fields drive every client:

| Field | Why it matters |
|---|---|
| `nodeAccount` | The Hive account that co-signs `create_collection` and `buy` via multisig. |
| `multisigSignerReady` | `false` means the node cannot co-sign right now; retry or use a different indexer. |

## The write path — how a transaction is produced

Every mutation follows the same three-stage pipeline:

```
1. build            2. sign                        3. broadcast
-------             ------                         ------------
SDK builder     →   hive-tx / wax / dhive      →   Hive RPC
returns an          produces a serialized          the indexer detects
unsigned            + signed Hive transaction      the custom_json and
operation                                          materializes state
```

The SDK owns stage 1 only. It is intentionally **transport-agnostic**: it returns a `KeychainResult<T>` containing raw Hive operations and the signer accounts, and you decide which library produces signatures.

### The `KeychainResult<T>` contract

Every `build*` function returns the same discriminated union. Three rules:

1. **Check `success` first** — every other field is only valid on the happy path.
2. **`operations` is ready to sign** — already in Hive's `["custom_json", {...}]` / `["transfer", {...}]` tuple format.
3. **`keyType` is authoritative** — it is `"Active"` for custody/delegation actions and `"Posting"` for non-custodial data, supply, schema, and node operations.

For the full type definition see [SDK Reference](sdk/reference.md#the-keychainresultt-contract).

## Your first mutation — mint a seed

Minting a seed (the non-distributable template from which playable instances are later produced) only requires your **posting key**, since `mint` is a posting-auth action. The seed belongs to a pre-existing collection; for a brand new collection the creator must run the two-op multisig flow (covered in the next section).

```typescript
import { buildSeed, PROTOCOL_ID } from "nftlox-sdk";
import hive from "hive-tx";

hive.config.set("node", "https://api.hive.blog");

const HIVE_ACCOUNT = "alice";
const POSTING_KEY = process.env.HIVE_POSTING_KEY!;
const COLLECTION_ID = "col_abcdef0123456789abcd"; // an existing col_ id

const result = await buildSeed({
	collectionId: COLLECTION_ID,
	signer: HIVE_ACCOUNT,
	artId: "founders-card",
	name: "Founder's Card",
	imageUrl: "https://example.com/cards/founder.png",
	maxSupply: 100,
	edition: 1,
	immutableData: {
		rarity: "legendary",
		card_type: "hero",
	},
});

if (!result.success) {
	for (const err of result.errors) {
		console.error(`${err.field}: ${err.message} [${err.code}]`);
	}
	process.exit(1);
}

console.log("Seed ID (pre-broadcast):", result.generatedIds?.seedId);

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.sign(hive.PrivateKey.from(POSTING_KEY));
const broadcast = await tx.broadcast();

if (broadcast?.error) {
	throw new Error(`Broadcast failed: ${JSON.stringify(broadcast.error)}`);
}

console.log("Broadcast tx_id:", broadcast?.result?.tx_id);
```

A few non-obvious points:

- **`signer` vs `owner`**: `signer` is the Hive account producing the custom_json; `owner` is where the seed lands. They default to the same account, so omit `owner` unless you are minting on someone else's behalf.
- **`edition`**: an integer ≥ 1. For a fresh collection, start at 1 and increment per seed.
- **`generatedIds.seedId`**: deterministic from `(collectionId, artId)`. You can compute it off-line with `generateDeterministicSeedId(collectionId, artId)` and pre-compute the full ID set before you ever broadcast.
- **`immutableData`**: validated against the collection schema by the indexer. If the collection has no schema, skip it.

## The read path — querying the indexer

Every read is an unauthenticated `GET`. The SDK ships a typed client that covers the whole surface:

```typescript
import { createIndexerClient } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");

const status = await client.getStatus();
const stats = await client.getStats();

const { nfts, counts } = await client.getUserNfts("alice", {
	status: "active",
	type: "seed",
	limit: 50,
});

const listings = await client.getListings({ sort: "price_asc", currency: "HIVE" });

// Wait for your freshly broadcast tx to be indexed:
const confirmation = await client.getOperationStatus(broadcast.result.tx_id);
console.log(`${confirmation.confirmed}/${confirmation.totalOperations} ops confirmed`);
```

`createIndexerClient(baseUrl)` uses the global `fetch` and works in browsers, Node, Bun, and Deno. Inject a custom `fetch` via the options object for tests or proxying.

## Next steps

| Topic | File |
|---|---|
| How `create_collection` and `buy` are co-signed by the node | [Signing & Broadcasting](broadcasting.md) |
| Exact shape of every on-chain payload | [Data Formats](data-formats.md) |
| The 20 builders in one table | [SDK Reference](sdk/reference.md) |
| Mint a full collection with dozens of seeds, end-to-end | [Seed Ceremony](use-cases/seed-ceremony.md) |
| Update `mutableData` on a live NFT | [Mutable Data](use-cases/mutable-data.md) |

## Protocol info

| Property | Value |
|---|---|
| Protocol ID | `nftlox_testnet` |
| Version | `0.11.0` |
| Minimum supported | `0.11.0` |
| Blockchain | Hive L1 |
| Finality | ~3 s (block time) |
| Max ops per custom_json tx | 5 |
| Max bulk distribute items | 50 |
| Collection creation fee | `0.100 HBD` |
| Protocol marketplace fee | 1% (100 bps) |
| Testnet indexer | `https://api-nftlox.hivecreators.co/api/` |

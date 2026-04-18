# Using the SDK

`nftlox-sdk` is a pure TypeScript library with one job: **produce unsigned Hive operations that satisfy the NFTLox protocol**. It has no HTTP server, no hidden key management, no wallet coupling. You sign what it builds; you broadcast from wherever you want.

This page walks the mental model end-to-end. For the full type-level inventory, see the [SDK Reference](reference.md).

## Install

```bash
npm install nftlox-sdk hive-tx
# or
bun add nftlox-sdk hive-tx
```

`nftlox-sdk` brings `@nftlox/protocol` as a transitive dependency and re-exports every type, constant, validator, and ID generator. You never need to import the protocol package directly.

Runtime targets: browsers, Node ≥ 18, Bun ≥ 1.0, Deno. Every hashing primitive is `crypto.subtle` — no Node-only APIs.

## The shape of every builder

Every `build*` function returns the same discriminated union:

```typescript
type KeychainResult<T> =
	| {
		success: true;
		operations: ReadonlyArray<HiveOperation | HiveTransferOperation>;
		keyType: "Active" | "Posting";
		signer: string;
		coSigners?: readonly CoSigner[];
		payload: ProtocolPayload<T>;
		generatedIds?: Record<string, string>;
		warnings?: readonly string[];
	  }
	| { success: false; errors: readonly ValidationError[] };
```

The three rules that follow from this shape:

1. **Narrow on `success` before touching anything else.** Errors are strongly typed (`{ field, message, code }`) and safe to surface directly in a form.
2. **`operations` is ready to sign.** It is already in Hive's tuple format `["custom_json", { … }]` / `["transfer", { … }]`. Hand it straight to `hive-tx`, `@hiveio/wax`, or `@hiveio/dhive`.
3. **`keyType` tells you which key.** `"Active"` only for `create_collection` and `buy`; `"Posting"` for everything else. Treat this value as authoritative — do not hardcode key types in your UI.

## Three flavors of flow

Every on-chain action in NFTLox collapses into one of three shapes. Recognizing which one you have changes how you broadcast.

### 1. Single-signer, posting auth (the common case)

Mint a seed, transfer, list, unlist, approve, lend — 17 of 20 actions.

```
build → sign(posting) → broadcast
```

Example with `buildTransfer`:

```typescript
import { buildTransfer } from "nftlox-sdk";
import hive from "hive-tx";

const result = await buildTransfer({
	nftId: "nft_abc…_7",
	from: "alice",
	to: "bob",
});

if (!result.success) {
	// { field, message, code }[]
	console.error(result.errors);
	return;
}

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.sign(hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!));
await tx.broadcast();
```

### 2. Single-signer, active auth + node multisig (buy)

```
build → sign(active) → POST /api/multisig → merge signatures → broadcast
```

`buildBuy` already produces the ordered `[...transfers, custom_json]` sequence with the right memos. Get the exact payment split from `client.getPaymentInfo(nftId)` — don't compute it yourself.

```typescript
import { buildBuy, createIndexerClient, requestBuyMultisig } from "nftlox-sdk";

const client = createIndexerClient(INDEXER);
const payment = await client.getPaymentInfo("nft_…");

const result = buildBuy({
	buyer: "alice",
	seller: payment.seller,
	nftId: payment.nftId,
	listingId: payment.listingId,
	listTxId: payment.listTxId,
	txId: payment.txId,
	paymentSplit: {
		sellerAmount: payment.sellerAmount,
		royaltyAmount: payment.royaltyAmount,
		royaltyRecipient: payment.royaltyRecipient,
		feeAmount: payment.feeAmount,
		feeAccount: payment.feeAccount,
		totalPrice: payment.totalPrice,
		currency: payment.currency as "HIVE" | "HBD",
	},
});
// …wrap, sign active, co-sign via requestBuyMultisig, broadcast
```

See [Signing & Broadcasting](../broadcasting.md) for the merge-signatures step.

### 3. Two-op, dual-signer (create_collection)

```
build → sign op[0] (active, creator) → POST /api/multisig/collection (node signs op[1]) → broadcast
```

`buildCollection` returns **two operations in one transaction**: a fee transfer from the creator, and a `custom_json` whose active-auth signer is the node account. Splitting them across transactions drops the payload — they must ship together.

```typescript
const result = await buildCollection(input, {
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	requireMultisigReady: true,
});

if (result.success) {
	console.log("Fee:", result.operations[0]);        // transfer
	console.log("Payload:", result.operations[1]);    // custom_json co-signed by node
	console.log("You will sign as:", result.signer);  // the creator, Active key
	console.log("Node co-signs op[1]:", result.coSigners?.[0]?.account);
}
```

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

This is the right pattern for:

- **Optimistic UI** — render the deep link before the block confirms.
- **Cross-references** — an immutable_data field can reference an unlaunched collection.
- **Airdrop scripts** — precompute every recipient's instance ID, then broadcast the batch.

`buildCollection`, `buildSeed`, and `buildList` expose the same values they compute via `result.generatedIds` — prefer that over re-hashing yourself.

## Schemas in one call

`createSchemaBuilder()` is a fluent typed builder for `CollectionSchema`. TypeScript enforces that field names are valid identifiers and field types are one of the 24 accepted primitives/arrays (`string`, `bool`, `uint8-64`, `int8-64`, `float`, `double`, and `[]` variants).

```typescript
import { createSchemaBuilder } from "nftlox-sdk";

const schema = createSchemaBuilder()
	.immutable("rarity", "string")
	.immutable("base_power", "uint16")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.build();

const result = await buildCollection({
	name: "Heroes",
	symbol: "HERO",
	creator: "alice",
	totalPotential: 1_000,
	metadata: { description: "Playable hero cards", image: "https://…" },
	rules: { transferable: true, burnable: true, royaltyPct: 5 },
	schema,
}, { indexerBaseUrl: INDEXER });
```

Immutable fields can only be set at mint time; mutable fields can be updated with `buildSetData` or `buildSetDataFrom` (operator-delegated). Schemas are append-only via `buildExtendSchema`.

## Reading indexed state

`createIndexerClient(baseUrl)` produces a typed `IndexerClient`. All methods are thin, typed wrappers around unauthenticated `GET` endpoints — no keys required.

```typescript
import { createIndexerClient } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");

const status    = await client.getStatus();
const stats     = await client.getStats();
const userNfts  = await client.getUserNfts("alice", { status: "active", type: "seed" });
const listings  = await client.getListings({ sort: "price_asc", currency: "HIVE" });
const nft       = await client.getNft("nft_…");
const proof     = await client.getNftProof("nft_…");   // SPV-compatible ownership proof
const loan      = await client.getNftLoan("nft_…");

// Wait for a freshly broadcast tx to be indexed:
const status = await client.getOperationStatus(broadcastTxId);
// { indexed, totalOperations, confirmed, invalid, orphaned, operations[] }
```

Inject a custom `fetch` via `createIndexerClient(url, { fetch })` for tests, proxying, or custom retry logic.

## Broadcasting helpers for large flows

### Bulk minting with `buildCollectionWithSeeds`

`buildCollectionWithSeeds` is the one-shot planner for launching a collection **and** all of its seeds. It returns:

- `collectionStep` — the 2-op dual-signer transaction (creator active key + node multisig).
- `seedBatches[]` — N posting-only transactions, each sized by `calculateMaxOperationsPerTx` so the payload never exceeds 90% of Hive's 8 KiB cap.

```typescript
const plan = await buildCollectionWithSeeds({
	name: "Heroes",
	symbol: "HERO",
	creator: "alice",
	totalPotential: 0,
	metadata: { description: "Heroes of Ragnarok", image: "https://…" },
	rules: { transferable: true, burnable: true, royaltyPct: 5 },
	seeds: [ /* array of 30 seeds */ ],
}, { indexerBaseUrl: INDEXER });

if (!plan.success) return console.error(plan.errors);

// 1. Broadcast collectionStep (creator signs active, node co-signs)
// 2. Broadcast seedBatches[0..N] (creator signs posting each time)
```

See [the Seed Ceremony example](../examples/seed-ceremony.md) for a complete script.

### Transaction sizing primitives

```typescript
import { splitIntoBatches, calculateMaxOperationsPerTx } from "nftlox-sdk";

const perTx = calculateMaxOperationsPerTx(sampleCustomJson);
const batches = splitIntoBatches(items, Math.min(perTx, MAX_OPERATIONS_PER_TX));
```

Use these when you build your own orchestrators (mass airdrop, schema migrations, L2 bridges) and want the same sizing guarantees `buildCollectionWithSeeds` uses internally.

## Error handling

```typescript
import { NftloxError, IndexerError, MultisigError } from "nftlox-sdk";

try {
	const sig = await requestBuyMultisig(INDEXER, request);
} catch (err) {
	if (err instanceof MultisigError) {
		// err.code: "NFT_LOCKED" | "RATE_LIMITED" | "INDEXER_LAGGED" | …
		// err.retryAfterMs: number | undefined
	} else if (err instanceof IndexerError) {
		// err.statusCode, err.responseBody, err.url
	}
}
```

All SDK errors extend `NftloxError`, which carries `.url` and a stable `.name`. Validation errors never throw — they live inside `result.errors`.

## When to reach for the SDK vs the indexer API

| Need | Use |
|---|---|
| Read protocol state (nfts, listings, stats, proofs) | `createIndexerClient` (GET) |
| Compute a deterministic ID off-line | `generate*` helpers |
| Build a signable Hive operation | `build*` builders |
| Co-sign a `buy` | `client.multisig(…)` or `requestBuyMultisig` |
| Co-sign a `create_collection` | `requestCreateCollectionMultisig` |
| Ship a full collection with seeds | `buildCollectionWithSeeds` |
| Stream indexed data | `client.get*` + your own poller |

The indexer **never** has the user's keys. It exposes read endpoints and two narrow co-signing endpoints (`/api/multisig`, `/api/multisig/collection`). Everything else is client-side.

## Next

- [Signing & Broadcasting](../broadcasting.md) — how to merge signatures for the multisig flows.
- [Data Formats](../data-formats.md) — the on-chain shape of every payload.
- [SDK Reference](reference.md) — full inventory of exports.
- [Seed Ceremony example](../examples/seed-ceremony.md) — runnable end-to-end flow.

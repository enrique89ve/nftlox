# SDK Reference

Full surface of `nftlox-sdk` — every builder, helper, client, and type that ships in the package. This is the authoritative map; short-form examples live in [Using the SDK](overview.md).

`nftlox-sdk` is a thin builder layer around the wire protocol defined in `@nftlox/protocol`. The protocol package is re-exported in full, so **one import** gives you every constant, type, ID generator, and validator:

```typescript
import {
	// builders
	buildCollection, buildSeed, buildList, buildBuy,
	// clients
	createIndexerClient, requestBuyMultisig,
	// helpers
	createSchemaBuilder, generateDeterministicCollectionId,
	// constants (re-exported from @nftlox/protocol)
	PROTOCOL_ID, PROTOCOL_VERSION, MAX_OPERATIONS_PER_TX, PROTOCOL_COLLECTION_FEE_HBD,
	// types
	type KeychainResult, type CollectionData, type NFTData,
} from "nftlox-sdk";
```

## The `KeychainResult<T>` contract

Every `build*` function returns the same discriminated union. Its shape is defined in `packages/sdk/src/builders/types.ts`:

```typescript
type KeychainResult<T> =
	| {
		readonly success: true;
		readonly operations: ReadonlyArray<HiveOperation | HiveTransferOperation>;
		readonly keyType: "Active" | "Posting";
		readonly signer: string;
		readonly coSigners?: readonly CoSigner[];
		readonly payload: ProtocolPayload<T>;
		readonly generatedIds?: Readonly<Record<string, string>>;
		readonly warnings?: readonly string[];
	}
	| {
		readonly success: false;
		readonly errors: readonly ValidationError[];
	};

type CoSigner = Readonly<{
	readonly op: number;          // index into `operations`
	readonly account: string;     // Hive account whose signature is required
	readonly keyType: "Active" | "Posting";
	readonly via: "multisig";     // obtained out-of-band (node endpoint)
}>;

type ValidationError = {
	readonly field: string;
	readonly message: string;
	readonly code: string;
};
```

- `success` is a compile-time discriminator — narrow on it before touching any other field.
- `operations` is already in Hive's `["custom_json", {...}]` / `["transfer", {...}]` tuple form. Pass directly to `hive-tx`, `@hiveio/wax`, or `dhive`.
- `keyType` tells the caller which private key to sign with (`Active` for `create_collection` and `buy`, `Posting` for everything else).
- `coSigners` is present on multi-signer flows (`buildCollection` and `buildBuy`). Hand the listed operation to the node's multisig endpoint — see [Signing & Broadcasting](../broadcasting.md).
- `generatedIds` surfaces deterministic IDs computed by the builder (`collectionId`, `seedId`, `listingId`, `listingNonce`, `originDna`) before the transaction is even broadcast. This is the hook for pre-computing links, caching, or optimistic UI.
- `warnings` are non-fatal ergonomic hints (long names, unusually high royalty, missing `imageUrl` on a list/transfer).

## Builders

Every builder validates its input with a Zod schema; the schema is exported alongside the builder so you can reuse it for form validation. Schemas end in `BuilderSchema` (e.g., `seedBuilderInputSchema`); inferred input types end in `BuilderInput`.

### Collections

| Builder | Signature | Auth | Ops | Notes |
|---|---|---|---|---|
| `buildCollection` | `(input, options) => Promise<KeychainResult<CollectionData>>` | Active + node multisig | `[transfer, custom_json]` | Two-op flow: fee transfer (creator → nodeAccount) + protocol payload signed by node. |
| `buildArchiveCollection` | `(input) => KeychainResult<ArchiveCollectionData>` | Posting | `[custom_json]` | Freezes a collection. Prevents further mints; existing NFTs keep trading. |
| `buildExtendSchema` | `(input) => KeychainResult<ExtendSchemaData>` | Posting | `[custom_json]` | Append-only: add new `immutable` and/or `mutable` fields. Existing fields are immutable post-create. |
| `buildCollectionWithSeeds` | `(input, options) => Promise<CollectionCreationPlan>` | mixed | multi-batch | Orchestrator: returns the collection step + N posting-only seed batches sized by `calculateMaxOperationsPerTx`. |

**`buildCollection` options**: either pass `{ nodeAccount: "nftlox" }` directly, or let the SDK resolve it from the indexer with `{ indexerBaseUrl, requireMultisigReady: true }`. Fee defaults to `PROTOCOL_COLLECTION_FEE_HBD` (`0.100 HBD`) but both `feeAmount` and `feeCurrency` (`"HIVE" | "HBD"`) are overridable. The fee transfer emitted by this builder carries memo `NFTLox FEE-COL:{collectionId}` — transfers without this exact memo are ignored by the indexer.

**Scaled fee (gated).** When `INSTANCE_FEE_ENABLED` is `true`, the builder computes the fee as `PROTOCOL_COLLECTION_FEE_HBD + INSTANCE_FEE_UNIT_HBD * ceil(maxInstances / INSTANCE_FEE_PER_N)` (see `computeCollectionFeeHbd` in `packages/sdk/src/builders/collection.ts`). The flag is currently `false`, so the fee is a flat `0.100 HBD`, but the `maxInstances` granularity rule (`0` or multiple of `1000`) is enforced today regardless — so payloads are forward-compatible. Passing `feeAmount` always overrides the computed amount.

**`CreateCollectionInput` (Zod)**:

```typescript
{
	name: string;                    // 1–100 chars
	symbol: string;                  // 3–10 chars, /^[A-Z][A-Z0-9]{2,9}$/
	creator: string;                 // Hive username
	totalPotential: number;          // non-negative integer, 0 = unlimited
	maxInstances: number;            // 0 (unlimited) OR a positive multiple of INSTANCE_FEE_PER_N (1000)
	metadata: {
		description: string;           // 1–250 chars
		image: string;                 // https URL, ≤500 chars
		externalUrl?: string;          // https URL, optional
	};
	rules: {
		transferable: boolean;
		burnable: boolean;
		royaltyPct: number;            // 0–50 (whole percent)
		royaltyRecipient?: string;     // Hive username, optional
	};
	schema?: {                       // optional — collections without a schema accept any data
		immutable: readonly SchemaField[];   // may be []
		mutable: readonly SchemaField[];     // ≥1 field required when `schema` is set
	};
}
```

### Seeds & Instances

A **seed** is the non-distributable template. It carries the visual asset, max supply, and any immutable per-seed fields. Instances are produced from seeds via `bulk_distribute`.

| Builder | Signature | Auth | Ops |
|---|---|---|---|
| `buildSeed` | `(input) => Promise<KeychainResult<NFTData>>` | Posting | `[custom_json]` |
| `buildSeedBatch` | `(input) => Promise<SeedBatchPlan>` | — (plan only) | — |
| `buildBulkDistribute` | `(input) => KeychainResult<BulkDistributeData>` | Posting | `[custom_json]` |

**`buildSeed` input**:

```typescript
{
	collectionId: string;            // existing col_ id
	signer: string;                  // Hive account producing the custom_json
	owner?: string;                  // where the seed lands; defaults to `signer`
	artId: string;                   // creator-chosen, sanitized; see `validateArtId`
	edition: number;                 // integer ≥ 1
	name: string;                    // ≤100 chars
	imageUrl: string;                // any valid URL, ≤500 chars
	maxSupply: number;               // integer ≥ 1 (how many instances can be distributed)
	brief?: string;                  // ≤250 chars
	immutableData?: Record<string, unknown>;   // ≤64 keys, validated against schema
	collectionBlock?: number;
}
```

`generatedIds.seedId` is deterministic — identical `(collectionId, artId)` pairs always produce the same ID. The SDK exposes `generateDeterministicSeedId(collectionId, artId)` so you can pre-compute the ID set before broadcasting.

**`buildSeedBatch`** validates a list of seeds in one pass (catches duplicate or malformed `artId`s) and returns a plan with resolved seed IDs. It does **not** build operations — it is the pre-flight that `buildCollectionWithSeeds` uses internally, exposed for consumers that want to validate before constructing transactions.

**`buildBulkDistribute`** produces instance NFTs from an existing seed:

```typescript
{
	creator: string;                 // must be the seed owner or an authorized distributor
	to?: string;                     // defaults to creator
	items: ReadonlyArray<{ seedId: string; quantity: number; seedTxId: string }>;
	imageOverrides?: Record<string, { imageUrl?: string; imageHash?: string }>;
	data?: Record<string, unknown>;
	mutableData?: Record<string, unknown>;
}
```

Caps: `MAX_BULK_DISTRIBUTE_ITEMS = 50` distinct seeds and `MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY = 250` instances per call. Duplicate `seedId`s are rejected — aggregate the quantity instead.

### Transfers & Burn

| Builder | Signature | Auth | Ops |
|---|---|---|---|
| `buildTransfer` | `(input) => Promise<KeychainResult<TransferData>>` | Posting | `[custom_json]` |
| `buildBurn` | `(input) => KeychainResult<TransferData>` | Posting | `[custom_json]` |

`buildBurn` is a thin wrapper that emits a `transfer` to the sentinel account `"null"`. It accepts either a single `nftId` or a `nftIds` array for bulk burn.

### Marketplace

| Builder | Signature | Auth | Ops |
|---|---|---|---|
| `buildList` | `(input) => Promise<KeychainResult<ListingData>>` | Posting | `[custom_json]` |
| `buildUnlist` | `(input) => Promise<KeychainResult<UnlistData>>` | Posting | `[custom_json]` |
| `buildBuy` | `(input) => KeychainResult<BuyData>` | Active + node multisig | `[...transfers, custom_json]` |

**`buildList`** generates a deterministic `listingId` and a random `listingNonce`. The nonce is what distinguishes re-listings of the same NFT at the same price — without it, relisting would collide with the previous ID.

```typescript
{
	owner: string;
	nftId: string;
	price: { amount: string; currency: "HIVE" | "HBD" };   // amount in 3-decimal string, ≥ 0.001
	expiresAt?: number;              // unix millis, must be > now
	imageUrl?: string;
	imageHash?: string;
	marketplace?: string;            // namespacing tag; empty ⇒ global listing
}
```

**`buildBuy`** produces an ordered sequence of transfers (seller payout, optional royalty, protocol fee) followed by the `buy` custom_json. The custom_json is co-signed by the node. The transfers use fixed memo prefixes (`MEMO_PREFIX_BUY`, `MEMO_PREFIX_ROYALTY`, `MEMO_PREFIX_FEE`) so the indexer can reconcile each transfer against its listing unambiguously. Get the `paymentSplit` object from `client.getPaymentInfo(nftId)`.

### Approvals & Delegation

| Builder | Purpose |
|---|---|
| `buildNftApprove` | Grant/revoke a single-instance spender. |
| `buildNftApproveAll` | Grant/revoke spender for a whole collection's instances owned by signer. |
| `buildNftTransferFrom` | Operator-initiated transfer of an instance previously approved. |
| `buildDataOperatorApprove` | Collection creator grants an operator rights to call `set_data_from`. |
| `buildSetDataFrom` | Operator updates `mutableData` on an instance they are approved for. |

All require Posting auth. `buildNftApprove` / `buildNftApproveAll` operate on **instances** only — seeds are never approvable (they are templates, not tradable assets).

### Lending

| Builder | Caller | Notes |
|---|---|---|
| `buildNftLend` | Owner | Lends an instance to a borrower. Owner and borrower must differ. |
| `buildNftReturn` | Borrower | Returns the instance. Signer must be the current borrower. |

Lending only applies to instances. Seeds cannot be lent.

### Data (per-instance)

| Builder | Caller | Notes |
|---|---|---|
| `buildSetData` | NFT owner | Updates `mutableData` (and optionally free-form `data`) on an instance. Validated against the collection schema. |
| `buildSetDataFrom` | Approved operator | Same effect, but authorized via `data_operator_approve`. |

### Node operations (optional for running an indexer)

| Builder | Purpose |
|---|---|
| `buildNodeRegister` | Announces an indexer's public endpoint + signing key. Requires ≥100 HP (self or delegated). |
| `buildNodeHeartbeat` | Periodic proof-of-liveness carrying a state-root hash. Default cadence: every 5000 blocks (~4h). |

## Helpers

### Schema construction

`createSchemaBuilder()` is a fluent builder for `CollectionSchema`. Field types are constrained by TypeScript: `"string" | "bool" | "uint8" | ... | "double" | "string[]" | ...` — 24 primitive and array types total (see `packages/sdk/src/schemas.ts`).

```typescript
import { createSchemaBuilder } from "nftlox-sdk";

const schema = createSchemaBuilder()
	.immutable("rarity", "string")
	.immutable("base_power", "uint16")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.build();
```

Pre-baked templates: `GAMING_SCHEMA`, `ART_SCHEMA`, `COLLECTIBLE_SCHEMA`, `MUSIC_SCHEMA`, and six `RAGNAROK_*_SCHEMA` references for TCG-style projects.

### Deterministic ID generators

All re-exported from `@nftlox/protocol`. They are pure, async (Web Crypto SHA-256), and domain-separated — identical inputs always produce identical IDs across machines and versions.

```typescript
generateDeterministicCollectionId(creator, name, symbol)   // "col_<20 hex>"
generateDeterministicSeedId(collectionId, artId)           // "seed_<20 hex>"
generateDeterministicInstanceId(seedId, instanceNumber)    // "nft_<20 hex>_<n>"
generateOriginDna(collectionId)                            // "o<15 upper-hex>"
generateInstanceDna(nftId, originDna, edition, imageHash)  // "i<19 upper-hex>"
generateImageHash(imageUrl)                                // "img_<16 hex>"
generateListingNonce()                                     // 12-char random
generateListingId(params)                                  // "list_<32 hex>"
```

Guards: `isSeedId(id)`, `isInstanceId(id)`, `extractSeedId(instanceId)`, `extractInstanceNumber(instanceId)`.

### ArtId validation

```typescript
sanitizeArtId(raw)                      // normalize to lowercase, strip invalid chars
generateArtIdFromName(name)             // produce a stable artId from a display name
validateArtId(artId)                    // { valid: boolean, error?: string }
validateArtIdArray(artIds)              // { valid, duplicates, formatErrors[] }
```

### Pre-broadcast NFT state validation

```typescript
validateNftOperation(op, nftState)
```

Cheap local check before broadcasting — detects the common "already listed / not owner / locked" cases so the UI can fail fast instead of eating a broadcast + wait cycle.

### Transaction sizing

```typescript
splitIntoBatches(items, maxOpsPerTx)
calculateMaxOperationsPerTx(sampleOperation)
```

Every Hive `custom_json` is capped at 8 KiB. The SDK uses 90% of that (`SAFE_PAYLOAD_MAX_BYTES`) and `MAX_OPERATIONS_PER_TX = 5`. `calculateMaxOperationsPerTx` measures your payload shape and returns the safe batch size — used internally by `buildCollectionWithSeeds` to decide how many seeds fit per broadcast.

### Inheritance

```typescript
resolveInstance(instance, seed)
```

Projects an `IndexerNftSummary` for a bare instance onto its seed, merging `immutableData`, visual metadata, and schema references — so a UI can render an instance with full context from a single seed lookup.

## Indexer client

`createIndexerClient(baseUrl, options?)` returns an `IndexerClient` interface backed by the global `fetch`. Works in browsers, Node ≥ 18, Bun, and Deno. Pass `options.fetch` to inject a custom fetch (proxying, mocks).

```typescript
const client = createIndexerClient("https://api-nftlox.hivecreators.co");

// Status & health
await client.getStatus();           // SyncStatus
await client.getHealth();           // HealthStatus (liveness + readiness probes)
await client.getStats();            // ProtocolStats
await client.getNodeAccount();      // string (resolved from status)
await client.getMultisigNodeAccount();  // same, but requires multisigSignerReady=true

// Collections
await client.getCollections({ creator, limit, offset });
await client.getCollection(id);
await client.getCollectionNfts(id, { type: "seed", limit });
await client.getCollectionStats(id);
await client.getCollectionSchemaHistory(id);

// NFTs
await client.getNft(id);
await client.getNftOwner(id);
await client.getNftOwnership(id);    // ownership proof
await client.getNftProof(id);        // SPV-style lineage proof
await client.getNftLoan(id);
await client.getNftInstances(seedId, { compact: true });

// Users
await client.getUserAssets(username);
await client.getUserNfts(username, { status: "active", type: "seed" });
await client.getUserNftCounts(username);
await client.getUserCollections(username);
await client.getUserLoans(username, { role: "lender" });

// Marketplace
await client.getListings({ sort: "price_asc", currency: "HIVE" });
await client.getSales({ buyer, limit });
await client.getSalesVolume({ collectionId });

// Ops
await client.getOperationStatus(txId);   // { indexed, confirmed, invalid, orphaned, operations[] }

// Multisig
await client.getPaymentInfo(nftId);      // PaymentInfo with full payment split
await client.multisig(buyRequest);       // co-sign a buy (PoW-gated; SDK solves automatically)
```

## Multisig client

Two wrappers for the node signing endpoints:

```typescript
requestBuyMultisig(baseUrl, { buyer, nftId, listingId, listTxId, transaction }, options?)
requestCreateCollectionMultisig(baseUrl, { transaction }, options?)
```

Both solve the required Proof-of-Work token automatically (default `DEFAULT_MULTISIG_POW_BITS = 16`). Override difficulty via `options.powBits` (max `MAX_MULTISIG_POW_BITS = 24`). A successful response is `{ ok: true, signature, digest, expiration }`; failure returns a typed `MultisigErrorCode` (`NFT_LOCKED`, `RATE_LIMITED`, `INDEXER_LAGGED`, …).

Supporting utilities:

```typescript
fetchNodeAccount(baseUrl, options?)           // resolves + optionally gates on multisigSignerReady
resolveNodeAccountFromStatus(status, options?)
fetchPaymentInfo(baseUrl, nftId)
```

## PoW primitives

Exposed for test harnesses and custom clients:

```typescript
solveMultisigPow(request, difficultyBits?)    // → opaque token for NFTLOX_POW_HEADER
canonicalPowJson(request)                     // deterministic serialization
hashJsonPayload(json)
hashMultisigPowToken(token)
hasLeadingZeroBits(hexHash, bits)
```

## SPV verification

`packages/sdk/src/spv/` exposes the tooling to verify ownership proofs without querying a full indexer database — useful for light clients, cross-node reconciliation, and untrusted mirrors. See the [SPV guide](../guides/spv.md). All exports are re-exported from the package root.

## Errors

Three classes, all extending `NftloxError` (which carries a `.url` field and a stable `.name`):

| Class | Thrown by | Extra fields |
|---|---|---|
| `IndexerError` | `createIndexerClient` HTTP calls | `statusCode`, `responseHeaders`, `responseBody`, `requestBodyValues` |
| `MultisigError` | `client.multisig`, `requestBuyMultisig`, `requestCreateCollectionMultisig` | `code: MultisigErrorCode`, `retryAfterMs?` |
| `NftloxError` | Base class | — |

Use `instanceof` to narrow.

## Constants worth knowing

Re-exported from `@nftlox/protocol`:

| Constant | Value | Meaning |
|---|---|---|
| `PROTOCOL_ID` | `"nftlox_testnet"` | The `id` field on every `custom_json`. |
| `PROTOCOL_VERSION` | `"0.6.2"` | The `version` field in every payload. |
| `MAX_OPERATIONS_PER_TX` | `5` | Hard cap per Hive transaction. |
| `MAX_BULK_DISTRIBUTE_ITEMS` | `50` | Max distinct seeds per `bulk_distribute`. |
| `MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY` | `250` | Max created instances per `bulk_distribute`. |
| `MAX_TRANSFER_BATCH_SIZE` | `50` | Max `nftIds` per bulk transfer/burn. |
| `SAFE_PAYLOAD_MAX_BYTES` | `7372` | 90% of Hive's 8 KiB custom_json ceiling. |
| `PROTOCOL_COLLECTION_FEE_HBD` | `"0.100"` | Default fee for `create_collection`. |
| `PROTOCOL_FEE_BPS` | `100` | Marketplace fee (1%). |
| `MAX_ROYALTY_PCT` | `50` | Royalty cap (whole %). |
| `MIN_PRICE_AMOUNT` | `"0.001"` | Minimum listing price. |
| `UNLIST_DELAY_BLOCKS` | `3` | Cooldown so in-flight `buy` multisigs outlive their unlist. |
| `MULTISIG_EXPIRATION_MS` | `125_000` | Expiration window on co-signed transactions. |

## Type re-exports

Every builder data type, action string, and validator type is re-exported. Key ones:

```typescript
// Wire payload
type ProtocolPayload<T> = { protocol: string; version: string; action: ProtocolAction; data: T };

// Action data types (one per ProtocolAction)
type CollectionData, NFTData, BulkDistributeData, TransferData, SetDataData,
     SetDataFromData, ListingData, UnlistData, BuyData,
     NftApproveData, NftApproveAllData, NftTransferFromData,
     DataOperatorApproveData, NftLendData, NftReturnData,
     NodeRegisterData, NodeHeartbeatData,
     ArchiveCollectionData, ExtendSchemaData;

// Discriminator
type ProtocolAction =
	| "create_collection" | "mint" | "transfer" | "bulk_distribute"
	| "set_data" | "extend_schema" | "archive_collection"
	| "node_register" | "node_heartbeat"
	| "list" | "unlist" | "buy"
	| "nft_approve" | "nft_approve_all" | "nft_transfer_from"
	| "nft_lend" | "nft_return"
	| "data_operator_approve" | "set_data_from";

type SupportedCurrency = "HIVE" | "HBD";
type NftKind = "seed" | "instance";
```

See [Data Formats](../data-formats.md) for the on-chain shape of every payload.

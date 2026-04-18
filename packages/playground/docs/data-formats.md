# Data Formats

Every mutation in NFTLox is a Hive operation whose payload is a `ProtocolPayload<T>` — a small envelope with a typed `data` field. This page is the authoritative map of what goes on-chain for each action.

## The wire envelope

```typescript
type ProtocolPayload<T> = {
	readonly protocol: string;         // "nftlox_testnet"
	readonly version: string;          // "0.6.0"
	readonly action: ProtocolAction;
	readonly data: T;                  // shape depends on action
};
```

Emitted as a Hive `custom_json`:

```json
["custom_json", {
	"required_auths": ["alice"],             // active-auth actions
	"required_posting_auths": [],            // or the inverse for posting-auth actions
	"id": "nftlox_testnet",
	"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.6.0\",\"action\":\"mint\",\"data\":{…}}"
}]
```

The `id` on the Hive op equals `PROTOCOL_ID`. The indexer filters custom_jsons by this id before parsing.

## Action → auth level

`create_collection` and `buy` sit in `required_auths` (active key). Everything else sits in `required_posting_auths` (posting key). The mapping is enforced by `ACTION_AUTH_LEVEL` in `packages/protocol/src/auth.ts` — there is no ambiguity and no override.

## Size limits

| Limit | Value |
|---|---|
| Hive `custom_json` hard cap | 8192 B |
| Safe budget (SDK enforced) | 7372 B (`SAFE_PAYLOAD_MAX_BYTES`, 90%) |
| Max ops per Hive tx | 5 |
| Max seeds per `bulk_distribute` | 50 |
| Max NFT ids per bulk `transfer` / burn | 50 |

Exceeding `SAFE_PAYLOAD_MAX_BYTES` throws `PayloadTooLargeError` with a suggested batch size.

---

## Action catalogue

Below is every action, the payload shape, and who is authorized to emit it. Type names match `@nftlox/protocol`.

### `create_collection` — dual-signer, fee-gated

**Auth:** Active (creator signs the transfer; node signs the custom_json via multisig).
**Wire shape:** 2 Hive operations in one transaction.

```typescript
type CollectionData = {
	readonly id: string;                     // "col_<20 hex>" deterministic from (creator, name, symbol)
	readonly name: string;                   // ≤100 chars
	readonly symbol: string;                 // 3–10 chars, uppercase
	readonly totalPotential: number;         // integer ≥ 0 (0 = unlimited)
	readonly originDna: string;              // "o<15 upper-hex>", deterministic
	readonly metadata: {
		readonly description: string;          // ≤250
		readonly image: string;                // https URL
		readonly externalUrl?: string;         // optional https URL
	};
	readonly rules: {
		readonly transferable: boolean;
		readonly burnable: boolean;
		readonly royaltyPct: number;           // 0–50 (whole percent)
		readonly royaltyRecipient?: string;
	};
	readonly schema?: CollectionSchema;      // optional; no schema ⇒ any data accepted
};
```

The `creator` is **not** in the payload — the indexer derives it from the fee transfer's `from` field. The two operations in a `create_collection` transaction:

```
op[0] = ["transfer", { from: "<creator>", to: "<nodeAccount>",
                       amount: "0.100 HBD",
                       memo: "NFTLox collection fee:<collectionId>" }]
op[1] = ["custom_json", { required_auths: ["<nodeAccount>"],
                          id: "nftlox_testnet",
                          json: "<ProtocolPayload<CollectionData>>" }]
```

### `archive_collection`

**Auth:** Posting (creator).

```typescript
type ArchiveCollectionData = { readonly collectionId: string };
```

Freezes the collection — new mints and `bulk_distribute` calls are rejected. Existing NFTs keep trading.

### `extend_schema`

**Auth:** Posting (creator).

```typescript
type ExtendSchemaData = {
	readonly collectionId: string;
	readonly newImmutableFields?: readonly SchemaField[];
	readonly newMutableFields?: readonly SchemaField[];
};

type SchemaField = { readonly name: string; readonly type: SchemaFieldType };
```

Append-only: existing fields are immutable. `name` must be a lowercase identifier; `type` is one of the 24 valid `SchemaFieldType` values (see below).

### `mint` (seed)

**Auth:** Posting.

```typescript
type NFTData = {
	readonly id: string;                     // seed_<20 hex>, deterministic from (collectionId, artId)
	readonly collectionId: string;
	readonly artId?: string;                 // required for seed mints; indexer recomputes the id and rejects mismatches
	readonly edition: number;                // integer ≥ 1
	readonly owner: string;
	readonly nftType?: "seed" | "instance";  // "seed" for mint; instances come from bulk_distribute
	readonly originDna: string;              // inherited from the collection
	readonly instanceDna: string;            // "i<19 upper-hex>", deterministic
	readonly uniqueAccessKey?: string;       // reserved for future use
	readonly mintedBy: string;
	readonly collectionBlock?: number;
	readonly metadata: {
		readonly name: string;                 // ≤100
		readonly description?: string;         // ≤250
		readonly imageUrl: string;             // ≤500
		readonly imageHash: string;            // "img_<16 hex>"
	};
	readonly maxSupply: number;
	readonly immutableData?: Record<string, unknown>;   // validated against the collection schema
	readonly mutableData?: Record<string, unknown>;
	readonly data?: Record<string, unknown>;            // free-form (ignored if schema present)
};
```

### `bulk_distribute`

**Auth:** Posting (seed owner, or an approved operator).

```typescript
type BulkDistributeData = {
	readonly to?: string;                    // defaults to signer
	readonly items: readonly BulkDistributeItem[];
	readonly imageOverrides?: Record<string, { imageUrl?: string; imageHash?: string }>;
	readonly data?: Record<string, unknown>;
	readonly mutableData?: Record<string, unknown>;
};

type BulkDistributeItem = {
	readonly seedId: string;
	readonly quantity: number;
	readonly seedTxId: string;               // the seed's originating tx_id; guards against stale references
};
```

Cap: 50 distinct seeds per call. Duplicate `seedId`s are rejected.

Instance IDs are computed server-side as `generateDeterministicInstanceId(seedId, instanceNumber)` = `nft_<seedSuffix>_<n>`; instance DNAs follow `generateDeterministicInstanceDna(seedId, n, txId, blockNum)`.

### `transfer` / burn

**Auth:** Posting (owner or approved operator).

```typescript
type TransferData = {
	readonly nftId?: string;                 // single
	readonly nftIds?: readonly string[];     // bulk (≤50)
	readonly from: string;
	readonly to: string;                     // "null" = burn
	readonly imageUrl?: string;
	readonly imageHash?: string;
	readonly seedId?: string;                // optional provenance reference
	readonly seedTxId?: string;
};
```

Either `nftId` or `nftIds` must be present. Burning is a transfer with `to = "null"`.

### `set_data`

**Auth:** Posting (NFT owner).

```typescript
type SetDataData = {
	readonly nftId: string;
	readonly instanceDna: string;            // owner-bound guard; prevents cross-NFT replays
	readonly data?: Record<string, unknown>;
	readonly mutableData?: Record<string, unknown>;
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

If the collection has a schema, payload fields are validated against the `mutable` section. Immutable fields cannot be touched.

### `set_data_from`

**Auth:** Posting (approved operator).

```typescript
type SetDataFromData = {
	readonly nftId: string;
	readonly instanceDna: string;
	readonly data?: Record<string, unknown>;
	readonly mutableData?: Record<string, unknown>;
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

Requires a prior `data_operator_approve(collectionId, operator, true)` from the collection creator.

### `data_operator_approve`

**Auth:** Posting (collection creator).

```typescript
type DataOperatorApproveData = {
	readonly collectionId: string;
	readonly operator: string;
	readonly approved: boolean;
};
```

### `list`

**Auth:** Posting (owner).

```typescript
type ListingData = {
	readonly nftId: string;
	readonly listingId: string;              // "list_<32 hex>", deterministic over (nftId, owner, marketplace, price, expiresAt, nonce)
	readonly listingNonce: string;           // 12 random chars — de-duplicates identical relistings
	readonly price: { readonly amount: string; readonly currency: "HIVE" | "HBD" };
	readonly expiresAt?: number;             // unix millis
	readonly imageUrl?: string;
	readonly imageHash?: string;
	readonly marketplace?: string;           // empty ⇒ global listing
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

Prices are 3-decimal strings, minimum `0.001`. Currency is `"HIVE"` or `"HBD"`.

### `unlist`

**Auth:** Posting (owner).

```typescript
type UnlistData = {
	readonly nftId: string;
	readonly imageUrl?: string;
	readonly imageHash?: string;
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

The NFT stays `status = "listed"` for `UNLIST_DELAY_BLOCKS` (3 blocks, ~9s) so in-flight `buy` multisigs can still settle. After the window it flips to `active`.

### `buy` — single-signer, node-cosigned

**Auth:** Active (buyer) + Active (node, via `/api/multisig`).

```typescript
type BuyData = {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;               // tx_id of the originating `list`
	readonly txId: string;                   // tx_id of this `buy` itself (precomputed client-side)
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

Wire shape (in order):

```
op[0..N-1] = ["transfer", …]     // seller, royalty recipient, protocol fee — memos use MEMO_PREFIX_BUY / ROYALTY / FEE
op[N]      = ["custom_json", …]   // BuyData, active-auth, buyer in required_auths
```

The indexer reconciles each transfer against the listing using the `listingId` embedded in the memo.

### `nft_approve`

**Auth:** Posting (owner).

```typescript
type NftApproveData = {
	readonly spender: string;
	readonly instanceId: string;
	readonly approved: boolean;
};
```

### `nft_approve_all`

**Auth:** Posting (owner).

```typescript
type NftApproveAllData = {
	readonly spender: string;
	readonly collectionId: string;
	readonly approved: boolean;
};
```

Scope: every instance in `collectionId` owned by the signer, including future acquisitions. Seeds are not covered.

### `nft_transfer_from`

**Auth:** Posting (operator previously approved via `nft_approve` or `nft_approve_all`).

```typescript
type NftTransferFromData = {
	readonly from: string;
	readonly to: string;
	readonly instanceId: string;
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

### `nft_lend`

**Auth:** Posting (owner).

```typescript
type NftLendData = {
	readonly instanceId: string;
	readonly borrower: string;               // must differ from owner
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

Lending is instance-only. While lent, `transfer`/`list`/`nft_approve` are rejected for that instance.

### `nft_return`

**Auth:** Posting (current borrower).

```typescript
type NftReturnData = {
	readonly instanceId: string;
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

### `node_register`

**Auth:** Posting. Requires ≥100 HP (self or delegated) at validation time.

```typescript
type NodeRegisterData = {
	readonly endpoint: string;               // https URL
	readonly publicKey: string;              // Hive public key string
};
```

### `node_heartbeat`

**Auth:** Posting (registered node account).

```typescript
type NodeHeartbeatData = {
	readonly blockNum: number;               // last block this node indexed
	readonly stateRoot: string;              // "sha256:<64 lowercase hex>"
	readonly indexerVersion: string;         // ≤32 chars
};
```

Cadence: ≤5000 blocks (~4h10m) apart. Missing it marks the node stale in `/api/l2_nodes` but does not kick it.

---

## Schema types

`SchemaFieldType` is one of 24 primitives, defined in `@nftlox/protocol`:

| Scalars | Arrays |
|---|---|
| `string`, `bool` | `string[]`, `bool[]` |
| `uint8`, `uint16`, `uint32`, `uint64` | `uint8[]`, `uint16[]`, `uint32[]`, `uint64[]` |
| `int8`, `int16`, `int32`, `int64` | `int8[]`, `int16[]`, `int32[]`, `int64[]` |
| `float`, `double` | `float[]`, `double[]` |

Rules:
- Field names match `/^[a-z][a-z0-9_]*$/` and are ≤64 chars.
- Max 64 fields per collection (`MAX_SCHEMA_FIELDS`).
- Immutable fields can only be written at mint time; mutable fields can be updated via `set_data` / `set_data_from`.
- Collections created without a `schema` accept **any** JSON in `data` / `immutableData` / `mutableData` — the indexer does no typing beyond size caps.

## Deterministic IDs at a glance

| ID | Format | Derived from |
|---|---|---|
| `col_<20 hex>` | collection | `sha256("nftlox:col:" + creator + ":" + name + ":" + symbol)` |
| `o<15 upper-hex>` | collection origin DNA | `sha256("nftlox:origin:" + collectionId)` |
| `seed_<20 hex>` | seed | `sha256("nftlox:seed:" + collectionId + ":" + artId.lower())` |
| `nft_<20 hex>_<n>` | instance | `seed_<suffix>_<instanceNumber>` |
| `i<19 upper-hex>` | instance DNA | `sha256("nftlox:instance:" + nftId + ":" + originDna + ":" + edition + ":" + imageHash)` (seeds) / `sha256("nftlox:dna:" + seedId + ":" + n + ":" + txId + ":" + blockNum)` (bulk-distributed instances) |
| `img_<16 hex>` | image hash | `sha256("nftlox:img:" + imageUrl)` |
| `list_<32 hex>` | listing | `sha256("nftlox:listing:v1:" + nftId + ":" + owner + ":" + marketplace + ":" + priceAmount + ":" + priceCurrency + ":" + expiresAt + ":" + nonce)` |

Domain separators (`nftlox:col:`, `nftlox:seed:`, …) are immutable — changing them would fork every historical ID.

## See also

- [SDK Reference](sdk/reference.md) — builder inputs that produce these payloads.
- [Signing & Broadcasting](broadcasting.md) — how the operations are wrapped and signed.
- [API Endpoints](reference/api.md) — the indexer routes that expose indexed versions of these shapes.

# Data Formats

Every mutation in NFTLox is a Hive operation whose payload is a `ProtocolPayload<T>` — a small envelope with a typed `data` field. The canonical protocol source is [`@nftlox/protocol`](../../protocol/README.md); this page is a readable companion for integrators.

## The wire envelope

```typescript
type ProtocolPayload<T> = {
	readonly protocol: string;         // "nftlox_testnet"
	readonly version: string;          // "0.10.0"
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
	"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.10.0\",\"action\":\"mint\",\"data\":{…}}"
}]
```

The `id` on the Hive op equals `PROTOCOL_ID`. The indexer filters custom_jsons by this id before parsing.

## Image & external URL wire format

Every URL-bearing field — `metadata.image` (collection), `metadata.externalUrl`, and `metadata.imageUrl` (seed mint) — is transported on-chain with the `https://` prefix **stripped**. This saves ~8 bytes per URL. Instance-level payloads (`bulk_distribute`, `transfer`, `list`, `unlist`) do not carry image URLs: instances inherit `image_url` from their seed via the FK chain at read time.

Canonical rule, implemented once in `@nftlox/protocol`:

```typescript
// Emitter side
toWireUrl("https://example.com/img.png")          // → "example.com/img.png"
toWireUrl("http://legacy.example/img.png")        // → "http://legacy.example/img.png" (preserved)
toWireUrl("example.com/img.png")                  // → "example.com/img.png" (already stripped)

// Reader side
fromWireUrl("example.com/img.png")                // → "https://example.com/img.png"
fromWireUrl("http://legacy.example/img.png")      // → "http://legacy.example/img.png"
```

SDK consumers never see the wire form: builders apply `toWireUrl` before emitting and `createIndexerClient`'s reader applies `fromWireUrl` on every returned `image_url` / `external_url` field. Integrators that bypass the SDK (parse raw Hive ops or hit `/api/*` with their own HTTP client) must apply these transforms themselves — both helpers are re-exported from `nftlox-sdk` and `@nftlox/protocol`.

`generateImageHash(url)` applies `toWireUrl` internally, so any shape of URL produces the canonical `img_*` id.

## Action → auth level

Three actions sit in `required_auths` (active key): `create_collection`, `buy_commitment`, and `buy`. Everything else sits in `required_posting_auths` (posting key). The mapping is enforced by `ACTION_AUTH_LEVEL` in `packages/protocol/src/auth.ts` — there is no ambiguity and no override.

A subset of those active-auth actions additionally require the signer to be a **registered active settlement node** at processing time. That rule is encoded in `NODE_SIGNED_ACTIONS` and enforced via `requiresActiveNodeSigner(action)` — it currently covers `buy_commitment` and `buy`. `create_collection` is active-signed by the creator (not by a node), so it is not in `NODE_SIGNED_ACTIONS`.

## Size limits

| Limit | Value |
|---|---|
| Hive `custom_json` hard cap | 8192 B |
| Safe budget (SDK enforced) | 7372 B (`SAFE_PAYLOAD_MAX_BYTES`, 90%) |
| Max ops per Hive tx | 5 |
| Max seeds per `bulk_distribute` | 50 |
| Max instances per `bulk_distribute` | 250 |
| Max NFT ids per bulk `transfer` / burn | 50 |

Exceeding `SAFE_PAYLOAD_MAX_BYTES` throws `PayloadTooLargeError` with a suggested batch size.

---

## Seed provenance (optional attestation)

Eight actions support optional `seedId?` and `seedTxId?` fields carrying a
self-attested provenance reference (the `SeedProvenance` type in
`@nftlox/protocol`):

- **Affected**: `transfer`, `list`, `unlist`, `set_data`, `set_data_from`,
  `nft_transfer_from`, `nft_lend`, `nft_return`.
- **If declared**: the indexer validates each field against the NFT's
  canonical `seed_id` and the seed's `created_tx_id`. Any mismatch, any
  wrong-type value, or any attempt to attach provenance to a seed NFT
  rejects the whole op before state mutation.
- **If absent**: the op processes normally (backwards-compatible).

This lets apps reading Hive L1 directly trust the provenance fields of
accepted ops without a second indexer round-trip after bootstrap. The
`items[].seedTxId` inside `bulk_distribute` is a different field — required
and validated since the first release.

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
	readonly maxInstances: number;           // 0 (unlimited) OR a positive multiple of INSTANCE_FEE_PER_N (1000)
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
                       memo: "NFTLox FEE-COL:<collectionId>" }]
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
	readonly nftDna: string;            // "i<19 upper-hex>", deterministic
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
	readonly mutableData?: Record<string, unknown>;     // validated against the schema's mutable section
};
```

### `bulk_distribute`

**Auth:** Posting (seed owner, or an approved operator).

```typescript
type BulkDistributeData = {
	readonly to?: string;                    // defaults to signer
	readonly items: readonly BulkDistributeItem[];
	readonly mutableData?: Record<string, unknown>;
};

type BulkDistributeItem = {
	readonly seedId: string;
	readonly quantity: number;
	readonly seedTxId: string;               // the seed's originating tx_id; guards against stale references
};
```

Cap: 50 distinct seeds per call. Duplicate `seedId`s are rejected.

Instance IDs are computed server-side as `generateDeterministicInstanceId(seedId, instanceNumber)` = `nft_<seedSuffix>_<n>`; instance DNAs follow `generateInstanceDna(seedId, n, txId, blockNum)`.

### `transfer` / burn

**Auth:** Posting (owner or approved operator).

```typescript
type TransferData = {
	readonly nftId?: string;                 // single
	readonly nftIds?: readonly string[];     // bulk (≤50)
	readonly to: string;                     // BURN_RECIPIENT ("null") = burn
	readonly seedId?: string;                // optional provenance reference
	readonly seedTxId?: string;
};
```

Either `nftId` or `nftIds` must be present. The sender is the Hive `custom_json` signer, not a payload field. Burning is a transfer with `to` set to the exported `BURN_RECIPIENT` constant — its literal value is `"null"`, Hive's reserved burn account.

### `set_data`

**Auth:** Posting (NFT owner).

```typescript
type SetDataData = {
	readonly nftId: string;
	readonly nftDna: string;            // owner-bound guard; prevents cross-NFT replays
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
	readonly nftDna: string;
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
	readonly marketplace?: string;           // empty ⇒ global listing
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

Prices are 3-decimal strings, minimum `0.100`. Currency is `"HIVE"` or `"HBD"`.

### `unlist`

**Auth:** Posting (owner).

```typescript
type UnlistData = {
	readonly nftId: string;
	readonly seedId?: string;
	readonly seedTxId?: string;
};
```

Unlist is instantaneous: the listing row is cleared in the same block. In-flight buy settlements are protected by the `buy_commitment` gate — a node that has already broadcast a commitment for the NFT holds it as `status = "pending_sale"`, and `handleUnlist` refuses to touch any `pending_sale` row. Once the commitment resolves (either the `buy` lands or the TTL expires), the NFT returns to `active`.

### `buy` — buyer-signed, node-settled

**Auth:** Active (buyer, signs the full tx locally) + Active (node, appends its signature and broadcasts via `/api/multisig/buy` — node-last flow).

```typescript
type BuyData = {
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;               // tx_id of the originating `list`
};
```

Wire shape (in order):

```
op[0..N-1] = ["transfer", …]     // seller, royalty recipient, protocol fee — memos use MEMO_PREFIX_BUY / ROYALTY / FEE
op[N]      = ["custom_json", …]   // BuyData, active-auth, nodeAccount in required_auths
```

The indexer reconciles each transfer against the listing using the `listingId` embedded in the memo. The `buy` payload MUST be preceded on chain by a matching `buy_commitment` emitted by the same settlement node — `handleBuy` rejects any buy whose reserving commitment is missing or belongs to another node.

### `buy_commitment` — server-side reservation (not client-facing)

**Auth:** Active (settlement node). Emitted by the node on `POST /api/multisig/buy` before it co-signs the buyer's transaction. Clients **never** build this op themselves; it is listed here because it appears on chain and in indexer logs.

```typescript
type BuyCommitmentData = {
	readonly txHash: string;                 // hash of the unsigned buyer tx the node will settle
	readonly nftId: string;
	readonly listingId: string;
	readonly listTxId: string;
	readonly buyer: string;                  // derived from the buyer tx's first transfer `from`
};
```

The network-wide block ordering of `buy_commitment` ops is the consensus on "which node settles this listing". First to land wins; other nodes with a competing commitment for the same `nftId` abort with `CROSS_NODE_RESERVATION`. Reservations expire after `BUY_COMMITMENT_TTL_BLOCKS` (~120 s, 40 blocks @ 3 s/block) if the matching `buy` does not follow. The HTTP-side observation budget the local node waits (`BUY_COMMITMENT_OBSERVATION_TIMEOUT_MS = 60 s`) is shorter; on `COMMITMENT_INCLUSION_TIMEOUT` the commitment may already be in Hive and the response carries `commitmentOpTxId` for reconciliation.

> The legacy `sale_lock` op (pre-0.7.0) is deprecated. Historical `sale_lock` ops on chain surface as `invalid_operations` for audit; there is no active handler.

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

Scope: every instance in `collectionId` owned by the signer while the approval remains active. Future acquisitions are covered only if the signer never dropped to zero owned NFTs in that collection; if they do, the approval is automatically removed. Seeds are not covered.

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

**Auth:** Posting (current borrower **or** lender — either party may end the loan).

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
};
```

The node's active public key is fetched from the Hive `accounts[].active.key_auths` when consumers need it; carrying a separate `publicKey` in the payload would reintroduce a drift vector if the on-chain account ever rotated keys.

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
- Collections created without a `schema` accept **any** JSON in `immutableData` / `mutableData` — the indexer does no typing beyond size caps.

## Deterministic IDs at a glance

| ID | Format | Derived from |
|---|---|---|
| `col_<20 hex>` | collection | `sha256("nftlox:col:" + creator + ":" + name + ":" + symbol)` |
| `o<15 upper-hex>` | collection origin DNA | `sha256("nftlox:origin:" + collectionId)` |
| `seed_<20 hex>` | seed | `sha256("nftlox:seed:" + collectionId + ":" + artId.lower())` |
| `nft_<20 hex>_<n>` | instance | `seed_<suffix>_<instanceNumber>` |
| `i<19 upper-hex>` | NFT DNA (seed or instance) | `sha256("nftlox:seed-dna:" + nftId + ":" + originDna + ":" + edition + ":" + imageHash)` (seeds) / `sha256("nftlox:dna:" + seedId + ":" + n + ":" + txId + ":" + blockNum)` (bulk-distributed instances). Both share `NFT_DNA_PREFIX = "i"`; the distinct hash-domain salts prevent cross-kind collisions. |
| `img_<16 hex>` | image hash | `sha256("nftlox:img:" + imageUrl)` |
| `list_<32 hex>` | listing | `sha256("nftlox:listing:v1:" + nftId + ":" + owner + ":" + marketplace + ":" + priceAmount + ":" + priceCurrency + ":" + expiresAt + ":" + nonce)` |

Domain separators (`nftlox:col:`, `nftlox:seed:`, …) are immutable — changing them would fork every historical ID.

## See also

- [SDK Reference](sdk/reference.md) — builder inputs that produce these payloads.
- [Signing & Broadcasting](broadcasting.md) — how the operations are wrapped and signed.
- [API Endpoints](reference/api.md) — the indexer routes that expose indexed versions of these shapes.

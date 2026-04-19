# NFTLox API Endpoints Reference

This document describes the indexer's HTTP surface. The indexer exposes two categories of endpoints:

- **Query API (GET)** — read-only endpoints for querying indexed protocol state.
- **Multisig API (POST)** — node co-signing endpoints for `buy` and `create_collection`.

Base URL: `https://api-nftlox.hivecreators.co/`. All responses are JSON. The API enforces ~1000 req/min/IP with standard rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`). While the indexer is catching up from genesis, data endpoints return `503 Service Unavailable` with `Retry-After: 30`; only `/api/health` and `/api/status` are always available.

> **There is no "build API".** Transactions are constructed **client-side** with the SDK builders (`nftlox-sdk`). The SDK returns unsigned Hive operations that you sign with your own keys (hive-tx, @hiveio/dhive, @hiveio/wax, or Hive Keychain) and broadcast to any Hive RPC. The indexer never sees your private keys and does not issue transactions on your behalf — it only co-signs `buy` and `create_collection` where the protocol requires a second signature. See [SDK Reference](../sdk/reference.md) for the full builder surface.

---

# Section 1: Query API (GET)

Read-only endpoints for querying indexed protocol state.

---

## Status

### GET /api/status

Sync status and node information.

**Parameters:** none

**Response:**

```json
{
	"protocolVersion": "0.6.0",
	"protocolId": "nftlox_testnet",
	"genesisBlock": 12345678,
	"nodeAccount": "nftlox",
	"nodeUrl": "https://api-nftlox.hivecreators.co",
	"multisigEnabled": true,
	"protocolFee": 1.0,
	"maxRoyalty": 50,
	"supportedCurrencies": ["HIVE", "HBD"],
	"lastBlock": 98765432,
	"headBlock": 98765435,
	"blocksBehind": 3,
	"inSync": true
}
```

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/status
```

---

### GET /api/health

Health check endpoint. Returns `200` if the indexer is healthy, `503` if unhealthy. Suitable for Docker HEALTHCHECK and load balancer probes.

**Parameters:** none

**Response:**

```json
{
	"status": "healthy",
	"db": "ok",
	"hive": "ok",
	"sync": "active",
	"inSync": true,
	"lastBlock": 98765432,
	"headBlock": 98765435,
	"blocksBehind": 3,
	"secondsSinceUpdate": 2
}
```

---

### GET /api/stats

Aggregate protocol statistics.

**Parameters:** none

**Response:**

```json
{
	"total_collections": 42,
	"total_nfts": 15000,
	"total_seeds": 500,
	"total_instances": 14000,
	"total_listed": 120,
	"total_burned": 80,
	"unique_owners": 350,
	"invalid_ops": 12,
	"total_schema_versions": 78,
	"sales": [
		{
			"currency": "HIVE",
			"total_volume": 5000.0,
			"total_royalties": 250.0,
			"total_fees": 50.0,
			"sale_count": 320
		},
		{
			"currency": "HBD",
			"total_volume": 1200.0,
			"total_royalties": 60.0,
			"total_fees": 12.0,
			"sale_count": 85
		}
	]
}
```

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/stats
```

---

### GET /api/operation-status/:txId

Check the status of a broadcast transaction. Returns one entry per NFTLox operation inside the Hive transaction, so a single transaction can report mixed confirmed/invalid results.

**Path parameters:**

| Parameter | Description |
|---|---|
| `txId` | Hive transaction ID (40-char hex) |

**Response:**

```json
{
	"txId": "506be0e61ae4dbb504397d7fb6ba59dbbab7e02e",
	"totalOperations": 1,
	"confirmed": 0,
	"invalid": 1,
	"orphaned": 0,
	"operations": [
		{
			"status": "invalid",
			"operationId": "90000150:4:0",
			"signer": "alice",
			"action": "bulk_distribute",
			"reason": "Signer alice is not the owner of seed seed_abc123",
			"blockNum": 90000150,
			"timestamp": "2026-03-30T15:00:00Z",
			"nftIds": []
		}
	]
}
```

| Status | Meaning |
|--------|---------|
| `confirmed` | Operation processed successfully |
| `invalid` | Operation rejected by indexer validation |
| `orphaned` | Buy operation failed but HIVE transfers were already broadcast |
| `unknown` | Transaction not found (not yet processed or record expired) |

> `nftIds` is intentionally bounded. Bulk creation operations such as `bulk_distribute` can return an empty array because each created NFT row stores its own creation and owner anchors.

> Invalid and orphaned records are retained for 24 hours, then automatically cleaned up. After cleanup, the endpoint returns `unknown`.

---

## Collections

### GET /api/collections

List collections with optional filtering by creator.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `creator` | string | -- | Filter by creator Hive username |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/collections?limit=10&offset=0"
```

**Response:** Array of collection objects with fields: `id`, `name`, `symbol`, `creator`, `origin_dna`, `total_potential`, `seed_count`, `instance_count`, and more.

---

### GET /api/collections/:id

Get a single collection by its deterministic ID.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | Collection ID |

**Response:** Full collection object including metadata, rules, schema, and timestamps.

**Error:** `404` if the collection does not exist.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/collections/abc123def456
```

---

### GET /api/collections/:id/nfts

List NFTs belonging to a collection.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | Collection ID |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `type` | string | -- | Filter by NFT type: `seed`, `instance` |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/collections/abc123def456/nfts?type=seed&limit=20"
```

**Response:** Paginated array of NFT objects.

---

### GET /api/collections/:id/stats

Aggregated statistics for a single collection.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | Collection ID |

**Response:** Object with counts for seeds, instances, listed, burned, unique owners, and floor price.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/collections/abc123def456/stats
```

---

### GET /api/collections/:id/schema-history

Returns the append-only hash chain of schema versions for a collection. Each version links to the previous via `prev_hash`, forming a verifiable chain.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | Collection ID |

**Response:** Array of schema version objects ordered by version number (ascending):

```json
[
	{
		"version": 1,
		"schema": {
			"immutable": [{ "name": "rarity", "type": "string" }],
			"mutable": [{ "name": "level", "type": "uint32" }]
		},
		"schema_hash": "a1b2c3d4e5f6...",
		"prev_hash": null,
		"block_num": 90000100,
		"tx_id": "abcdef1234567890abcdef1234567890abcdef12"
	},
	{
		"version": 2,
		"schema": {
			"immutable": [{ "name": "rarity", "type": "string" }],
			"mutable": [{ "name": "level", "type": "uint32" }, { "name": "xp", "type": "uint64" }]
		},
		"schema_hash": "f6e5d4c3b2a1...",
		"prev_hash": "a1b2c3d4e5f6...",
		"block_num": 90000200,
		"tx_id": "1234567890abcdef1234567890abcdef12345678"
	}
]
```

**Error:** `404` if the collection does not exist.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/collections/abc123def456/schema-history
```

---

## NFTs

### GET /api/nfts/:id

Get full details for a single NFT.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | NFT ID |

**Response:** Complete NFT object including:
- `id`, `name`, `image_url`
- `collection_id`, `edition`, `nft_type` (seed/instance)
- `owner`, `status` (active/listed/lent)
- `origin_dna`, `instance_dna`, `immutable_data`, `data_hash`
- `max_supply`, `distributed`, `supply_exhausted`, `seed_id`, `instance_number`
- `listing_id`, `listing_tx_id`, `listing_price`, `listing_currency`, `listing_expires_at`, `listing_marketplace`, `listing_expired`
- `schema_version`, `previous_owner`, `owner_operation_id`, `owner_action`, `owner_block_num`
- `tx_id`, `created_at`, `seed_tx_id`

> All NFT list endpoints (collection NFTs, user NFTs, marketplace listings) also include `schema_version`, `previous_owner`, `owner_operation_id`, `owner_action`, and `owner_block_num` in each NFT object.

**Error:** `404` if the NFT does not exist.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/my-nft-id
```

---

### GET /api/nfts/:id/owner

Fast current-owner claim for a single NFT. This is the lightweight route for UI reads and high-throughput checks.

**Response:**

```json
{
	"id": "my-nft-id",
	"owner": "alice",
	"previous_owner": "bob",
	"owner_action": "buy",
	"owner_operation_id": "90000150:4:0",
	"owner_block_num": 90000150,
	"claim_hash": "8a1f..."
}
```

`owner_operation_id` is the authoritative anchor. The SDK can resolve it through HAFAH/Hive L1 to prove the claim. `owner_block_num` is useful context but not unique proof by itself because one block can contain multiple ownership operations.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/my-nft-id/owner
```

---

### GET /api/nfts/:id/ownership

Canonical ownership proof. Returns the current owner claim plus creation anchors needed by SPV verification.

**Response:** Same fields as `/owner`, plus:

```json
{
	"created_operation_id": "89999999:2:0",
	"created_block_num": 89999999,
	"created_tx_id": "1234567890abcdef1234567890abcdef12345678",
	"nft_type": "instance",
	"seed_id": "seed-id",
	"instance_number": 42,
	"instance_dna": "4fc2..."
}
```

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/my-nft-id/ownership
```

---

### GET /api/nfts/:id/proof

Compatibility alias for the ownership proof contract. New integrations should prefer `/ownership`; existing SDK SPV clients can keep using `/proof`.

---

### GET /api/nfts/:id/loan

Return active loan custody for an NFT without changing ownership semantics.

**Response when lent:**

```json
{
	"nft_id": "my-nft-id",
	"active": true,
	"loan": {
		"nft_id": "my-nft-id",
		"owner": "alice",
		"lender": "alice",
		"borrower": "bob",
		"status": "lent",
		"loan_operation_id": "90000150:4:0",
		"loan_block_num": 90000150,
		"loan_tx_id": "1234567890abcdef1234567890abcdef12345678"
	}
}
```

**Response when not lent:**

```json
{
	"nft_id": "my-nft-id",
	"active": false,
	"loan": null
}
```

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/my-nft-id/loan
```

---

### GET /api/nfts/:id/instances

List instances distributed from a seed NFT.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | Seed NFT ID |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |
| `compact` | boolean | false | Return the seed once plus instance deltas for lower payload size |

**Response:** Paginated array of instance NFT objects.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/nfts/seed-id/instances?limit=20"
```

---

## Users

### GET /api/users/:username/assets

Dashboard-oriented asset overview. This route is for frontend and SDK overview screens; use paginated domain routes for full lists.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `previewLimit` | number | 6 | Max preview items per section (1-20) |

**Response:** Counts plus preview arrays for owned NFTs, seeds, lent-out NFTs, borrowed NFTs, and created collections.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/users/alice/assets?previewLimit=6"
```

---

### GET /api/users/:username/nfts

Get NFTs owned by a user with aggregate counts. This route means real ownership (`nfts.owner = username`), not borrowed custody.

**Path parameters:**

| Parameter | Description |
|---|---|
| `username` | Hive username |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | -- | Filter: `active`, `listed`, `lent` |
| `type` | string | -- | Filter: `seed`, `instance` |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Object containing `nfts` array, `counts` breakdown, `offset`, and `limit`.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/users/alice/nfts?status=active&limit=20"
```

---

### GET /api/users/:username/nfts/count

Get NFT count breakdown for a user.

**Path parameters:**

| Parameter | Description |
|---|---|
| `username` | Hive username |

**Response:** Counts by type (seeds, instances), excluding burned NFTs.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/users/alice/nfts/count
```

---

### GET /api/users/:username/loans

Get active NFT loans for a user by role.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `role` | string | `all` | Filter: `lender`, `borrower`, `all` |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Object containing `loans`, `total`, `role`, `offset`, and `limit`.

Use `role=lender` for NFTs the user has lent out, and `role=borrower` for NFTs temporarily usable by the user.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/users/alice/loans?role=lender&limit=20"
```

---

### GET /api/users/:username/collections

Get collections created by a user.

**Path parameters:**

| Parameter | Description |
|---|---|
| `username` | Hive username |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Array of collection objects.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/users/alice/collections?limit=10"
```

---

## Marketplace

### GET /api/marketplace/listings

Browse NFTs currently listed for sale.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sort` | string | `recent` | Sort order: `price_asc`, `price_desc`, `recent` |
| `currency` | string | -- | Filter by currency: `HIVE`, `HBD` |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Paginated array of listed NFT objects including listing price, currency, and seller info.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/marketplace/listings?sort=price_asc&currency=HIVE&limit=20"
```

---

### GET /api/marketplace/sales

Sales history with financial split breakdown. Without filters, returns recent sales.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `nftId` | string | -- | Filter by NFT ID |
| `collectionId` | string | -- | Filter by collection ID |
| `seller` | string | -- | Filter by seller Hive username |
| `buyer` | string | -- | Filter by buyer Hive username |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Paginated array of sale objects:

```json
[
	{
		"nft_id": "abc123",
		"collection_id": "col_xyz",
		"seller": "alice",
		"buyer": "bob",
		"gross_amount": 10.0,
		"currency": "HIVE",
		"royalty_amount": 0.5,
		"protocol_fee": 0.1,
		"seller_net": 9.4,
		"block_num": 90000300,
		"tx_id": "abcdef1234567890abcdef1234567890abcdef12",
		"timestamp": "2026-03-31T10:00:00Z"
	}
]
```

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/marketplace/sales?collectionId=col_xyz&limit=20"
```

---

### GET /api/marketplace/volume

Aggregated trading volume by currency with royalties and fees breakdown. Optionally scoped to a single collection.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `collectionId` | string | -- | Filter by collection ID |

**Response:** Array of volume objects, one per currency:

```json
[
	{
		"currency": "HIVE",
		"total_volume": 5000.0,
		"total_royalties": 250.0,
		"total_fees": 50.0,
		"sale_count": 320
	},
	{
		"currency": "HBD",
		"total_volume": 1200.0,
		"total_royalties": 60.0,
		"total_fees": 12.0,
		"sale_count": 85
	}
]
```

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/marketplace/volume?collectionId=col_xyz"
```

---

## Multisig

### GET /api/payment-info/:nftId

Get the payment split needed to build a buy transaction. Returns the exact amounts for seller, royalty, and protocol fee.

**Path parameters:**

| Parameter | Description |
|---|---|
| `nftId` | ID of the listed NFT |

**Response:**

```json
{
	"nftId": "abc123",
	"listingId": "list_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
	"listTxId": "abcdef1234567890abcdef1234567890abcdef12",
	"seller": "alice",
	"totalPrice": 10.0,
	"currency": "HIVE",
	"sellerAmount": 9.9,
	"royaltyAmount": 0,
	"royaltyRecipient": null,
	"feeAmount": 0.1,
	"feeAccount": "nftlox",
	"nodeAccount": "nftlox",
	"txId": "1234567890abcdef1234567890abcdef12345678",
	"seedTxId": null
}
```

> **Fee model**: Protocol fee is 1.0%, always paid to the co-signing node. Marketplace fees are handled off-chain by marketplace frontends.

**Errors:**
- `404` -- NFT not found
- `400` -- NFT not listed or has no valid price

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/payment-info/my-nft-id
```

---

### POST /api/multisig

Submit a buy transaction for multisig co-signing by the node. The node validates the NFT state, verifies the payment split matches the listing, and adds its signature.

**Request body:**

```json
{
	"buyer": "bob",
	"nftId": "abc123",
	"listingId": "list_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
	"listTxId": "abcdef1234567890abcdef1234567890abcdef12",
	"transaction": {
		"ref_block_num": 12345,
		"ref_block_prefix": 67890,
		"expiration": "2026-03-29T12:00:00",
		"operations": [],
		"signatures": []
	}
}
```

> The `listingId` and `listTxId` must match the active listing. The `signatures` array must be empty -- the node adds its signature and returns it.

**Response (success):**

```json
{
	"ok": true,
	"signature": "node-signature-hex",
	"digest": "tx-digest-hex",
	"expiration": "2026-03-28T12:00:00"
}
```

**Error codes:** See [errors.md](errors.md) for the full list of `MultisigErrorCode` values.

---

### POST /api/multisig/collection

Submit a `create_collection` transaction for node co-signing. This is the dual-signer flow: the creator's active key signs the fee transfer, the node's active key co-signs the `custom_json` so the collection row can be anchored to an operation both parties authorized.

**Request body:**

```json
{
	"transaction": {
		"ref_block_num": 12345,
		"ref_block_prefix": 67890,
		"expiration": "2026-03-29T12:00:00",
		"operations": [
			["transfer", { "from": "alice", "to": "nftlox", "amount": "0.100 HBD", "memo": "NFTLox CREATE_COLLECTION:…" }],
			["custom_json", { "required_auths": ["nftlox"], "required_posting_auths": [], "id": "nftlox_testnet", "json": "…" }]
		],
		"signatures": []
	}
}
```

**Response (success):**

```json
{
	"ok": true,
	"signature": "node-signature-hex",
	"digest": "tx-digest-hex",
	"expiration": "2026-03-29T12:00:00"
}
```

**Error codes:** Shares the `MultisigErrorCode` surface with `/api/multisig` (plus `INVALID_TX_STRUCTURE` when the transaction isn't a valid `create_collection` envelope).

SDK helper: `requestCreateCollectionMultisig(baseUrl, { transaction })`. PoW-gated — see [PoW primitives in the SDK reference](../sdk/reference.md#proof-of-work).

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
	"error": "Description of what went wrong"
}
```

Common HTTP status codes:

| Status | Meaning |
|---|---|
| `200` | Success |
| `400` | Bad request (validation error) |
| `404` | Resource not found |
| `429` | Rate limited |
| `503` | Indexer syncing or unhealthy |

---

## Caching

The API sets `Cache-Control` headers on all `GET` responses:

- Stats and health endpoints: `public, max-age=10`
- All other data endpoints: `public, max-age=2`
- Error responses: `no-store`

---

# Section 2: Constructing transactions (client-side)

The indexer does not expose a transaction-building HTTP surface. Every NFTLox action — collections, seeds, instances, marketplace, lending, allowances — is built locally with the `nftlox-sdk` builder that matches the action.

| Action | SDK builder | Key | Signer flow |
|---|---|---|---|
| `create_collection` | `buildCollection`, `buildCollectionWithSeeds` | Active | Creator + node multisig (`POST /api/multisig/collection`) |
| `mint` (seed) | `buildSeed` | Posting | Creator single-signer |
| `bulk_distribute` | `buildBulkDistribute` | Posting | Seed owner single-signer |
| `transfer`, `burn` | `buildTransfer`, `buildBurn` | Posting | Owner single-signer |
| `set_data` | `buildSetData` | Posting | Owner single-signer |
| `set_data_from` | `buildSetDataFrom` | Posting | Approved data operator |
| `extend_schema` | `buildExtendSchema` | Posting | Creator single-signer |
| `archive_collection` | `buildArchiveCollection` | Posting | Creator single-signer |
| `list`, `unlist` | `buildList`, `buildUnlist` | Posting | Owner single-signer |
| `buy` | `buildBuy` | Active | Buyer + node multisig (`POST /api/multisig`) |
| `nft_approve`, `nft_approve_all` | `buildNftApprove`, `buildNftApproveAll` | Posting | Owner single-signer |
| `nft_transfer_from` | `buildNftTransferFrom` | Posting | Approved spender single-signer |
| `data_operator_approve` | `buildDataOperatorApprove` | Posting | Collection creator single-signer |
| `nft_lend`, `nft_return` | `buildNftLend`, `buildNftReturn` | Posting | Owner / borrower single-signer |

Every builder returns a `KeychainResult<T>` — a discriminated union of `{ success: true, operations, keyType, signer, payload, generatedIds?, coSigners?, warnings? }` or `{ success: false, errors }`. Feed `operations` into `hive-tx`, `@hiveio/dhive`, `@hiveio/wax`, or `hive_keychain.requestBroadcast` — whatever your runtime uses.

Full reference:

- [SDK Reference — all builders](../sdk/reference.md)
- [Signing & Broadcasting](../broadcasting.md) — three signer flows with runnable examples per library.
- [Data Formats](../data-formats.md) — the exact JSON each builder produces.

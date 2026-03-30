# NFTLox API Reference

Base URL:

```
https://api-nftlox.hivecreators.co/api/
```

All endpoints return JSON. Rate limit: **1000 requests per minute per IP**. Rate limit headers are included in every response:

- `X-RateLimit-Limit` -- max requests per window
- `X-RateLimit-Remaining` -- remaining requests
- `X-RateLimit-Reset` -- window reset timestamp (ms)

When the limit is exceeded, the API returns `429 Too Many Requests` with a `Retry-After` header.

While the indexer is syncing, all data endpoints return `503 Service Unavailable` with a `Retry-After: 30` header. Only `/api/health` and `/api/status` are available during sync.

---

## Status

### GET /api/status

Sync status and node information.

**Parameters:** none

**Response:**

```json
{
	"protocolVersion": "0.4.0",
	"protocolId": "nftlox_testnet",
	"genesisBlock": 12345678,
	"nodeAccount": "nftlox",
	"nodeUrl": "https://api-nftlox.hivecreators.co",
	"multisigEnabled": true,
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
	"total_replicas": 500,
	"total_listed": 120,
	"total_burned": 80,
	"unique_owners": 350,
	"invalid_ops": 12
}
```

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/stats
```

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
| `type` | string | -- | Filter by NFT type: `seed`, `instance`, `replica` |
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

**Response:** Object with counts for seeds, instances, replicas, listed, burned, unique owners, and floor price.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/collections/abc123def456/stats
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
- `id`, `name`, `image_url`, `image_hash`
- `collection_id`, `edition`, `nft_type` (seed/instance/replica)
- `owner`, `minted_by`, `status` (active/listed/burned)
- `origin_dna`, `instance_dna`, `unique_access_key`
- `max_replicas`, `distributed`, `seed_id`, `instance_number`
- `listing_price`, `listing_currency`, `listing_marketplace`
- `immutable_data`, `mutable_data`, `owner_data`
- `birth_block`, `birth_tx`, `created_at`

**Error:** `404` if the NFT does not exist.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/my-nft-id
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

**Response:** Paginated array of instance NFT objects.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/nfts/seed-id/instances?limit=20"
```

---

## Users

### GET /api/users/:username/nfts

Get a user's NFTs with aggregate counts.

**Path parameters:**

| Parameter | Description |
|---|---|
| `username` | Hive username |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | -- | Filter: `active`, `listed`, `burned` |
| `type` | string | -- | Filter: `seed`, `instance`, `replica` |
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

**Response:** Counts by type (seeds, instances, replicas), excluding burned NFTs.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/users/alice/nfts/count
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

### GET /api/users/:username/packs

Get pack balances for a user. Only packs with balance > 0 are returned.

**Path parameters:**

| Parameter | Description |
|---|---|
| `username` | Hive username |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Array of pack balance objects.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/users/alice/packs
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

## Packs

### GET /api/packs

List available packs.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `collectionId` | string | -- | Filter by collection ID |
| `limit` | number | 50 | Results per page (1-200) |
| `offset` | number | 0 | Pagination offset |

**Response:** Array of pack objects including name, description, drop table, items per pack, price, max supply, and current supply.

**Example:**

```bash
curl "https://api-nftlox.hivecreators.co/api/packs?collectionId=abc123&limit=10"
```

---

### GET /api/packs/:id

Get a single pack by ID.

**Path parameters:**

| Parameter | Description |
|---|---|
| `id` | Pack ID |

**Response:** Full pack object.

**Error:** `404` if the pack does not exist.

**Example:**

```bash
curl https://api-nftlox.hivecreators.co/api/packs/pack-id-here
```

---

## Multisig

### GET /api/payment-info/:nftId

Get the payment split needed to build a buy transaction. This returns the exact amounts for seller, royalty, and protocol fee.

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
	"nodeAccount": "nftlox"
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

> The `listingId` and `listTxId` must match the active listing. The `signatures` array must be empty — the node adds its signature and returns it.

**Response (success):**

```json
{
	"ok": true,
	"signature": "node-signature-hex",
	"digest": "tx-digest-hex",
	"expiration": "2026-03-28T12:00:00"
}
```

**Error codes:**

| Code | Description |
|---|---|
| `MULTISIG_DISABLED` | Node does not have multisig enabled (503) |
| `RATE_LIMITED` | Too many requests from this buyer (429) |
| `NFT_LOCKED` | NFT is being purchased by another buyer (409) |
| `NFT_NOT_FOUND` | NFT does not exist (400) |
| `NFT_NOT_LISTED` | NFT is not currently listed (400) |
| `NFT_EXPIRED_LISTING` | Listing has expired (400) |
| `CANNOT_BUY_OWN` | Buyer is the seller (400) |
| `INVALID_PAYMENT_SPLIT` | Payment amounts do not match expected split (400) |
| `INVALID_PROTOCOL_PAYLOAD` | Protocol payload in custom_json is invalid (400) |
| `NODE_ACCOUNT_MISMATCH` | Transaction does not reference the correct node account (400) |
| `MISSING_BUYER_AUTH` | Buyer signature is missing (400) |
| `INVALID_TX_STRUCTURE` | Transaction structure is malformed (400) |

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

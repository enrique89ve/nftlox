# NFTLox API Endpoints Reference

This document consolidates all NFTLox API endpoints into a single reference. Endpoints are organized into two categories:

- **Query API (GET)** -- Read-only endpoints served by the indexer for querying protocol state. Base URL: `https://api-nftlox.hivecreators.co/api/`
- **Build API (POST)** -- Write endpoints that construct unsigned Hive `custom_json` operations. The client is responsible for signing and broadcasting. Base URL: `https://nftloxtest.hivecreators.co` (playground server).

All endpoints return JSON. The Query API enforces a rate limit of **1000 requests per minute per IP** with standard rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`). While the indexer is syncing, data endpoints return `503 Service Unavailable` with `Retry-After: 30`. Only `/api/health` and `/api/status` are available during sync.

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
- `mint_block`, `mint_tx`, `created_at`

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

**Error codes:** See [error-codes.md](error-codes.md) for the full list of `MultisigErrorCode` values.

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

# Section 2: Build API (POST)

The Build API constructs unsigned Hive `custom_json` operations for the NFTLox protocol. It does **not** broadcast transactions -- the client is responsible for signing the returned operations with the appropriate Hive key and broadcasting them to the blockchain.

**Protocol version:** `0.4.0`

---

## Build Response Format

All Build API endpoints return JSON with the following standard shape:

```json
{
	"success": true,
	"protocolVersion": "0.4.0",
	"operation": ["custom_json", { ... }],
	"payload": { "protocol": "nftlox_testnet", "version": "0.4.0", "action": "...", "data": { ... } },
	"keyType": "Posting"
}
```

| Field             | Type       | Description                                                                 |
|-------------------|------------|-----------------------------------------------------------------------------|
| `success`         | `boolean`  | Whether the build succeeded.                                                |
| `protocolVersion` | `string`   | Protocol version used (`0.4.0`).                                            |
| `hashVersion`     | `string`   | Hash version (present on collection/seed endpoints): `v1`.                  |
| `operation`       | `array`    | Hive operation tuple `["custom_json", {...}]`, ready to sign.               |
| `payload`         | `object`   | The decoded protocol payload embedded inside the operation's `json` field.  |
| `keyType`         | `string`   | Which Hive key to sign with: `"Posting"` or `"Active"`.                     |
| `generatedId`     | `string`   | Deterministic ID generated for the resource (collections, seeds, packs).    |
| `generatedIds`    | `object`   | Map of all generated IDs (e.g. `{ collectionId, originDna }`).              |
| `warnings`        | `string[]` | Optional advisory messages (high royalty, large supply, etc.).               |
| `errors`          | `array`    | Present when `success: false`. Array of `{ field, message, code }` objects. |

Error response (400):
```json
{
	"success": false,
	"errors": [
		{ "field": "name", "message": "Name is required", "code": "..." }
	]
}
```

---

## Protocol Constants

| Constant                     | Value    | Description                                |
|------------------------------|----------|--------------------------------------------|
| `MAX_NAME_LENGTH`            | 100      | Maximum collection/seed name length.       |
| `MAX_DESCRIPTION_LENGTH`     | 250      | Maximum description length.                |
| `MAX_IMAGE_URL_LENGTH`       | 500      | Maximum image URL length.                  |
| `MIN_SYMBOL_LENGTH`          | 3        | Minimum symbol length.                     |
| `MAX_SYMBOL_LENGTH`          | 8        | Maximum symbol length.                     |
| `SYMBOL_REGEX`               | `^[A-Z0-9]{3,8}$` | Valid symbol pattern.               |
| `MAX_OPERATIONS_PER_TX`      | 5        | Max operations per Hive transaction.       |
| `MAX_BULK_DISTRIBUTE_ITEMS`  | 50       | Max items in a bulk distribute.            |
| `MAX_DROP_TABLE_ENTRIES`     | 50       | Max entries in a pack drop table.          |
| `MAX_ITEMS_PER_PACK`         | 20       | Max items revealed per pack open.          |
| `MAX_PACK_OPEN_BATCH`        | 50       | Max packs opened/bought in one call.       |
| `MAX_ROYALTY_PCT`            | 50       | Maximum royalty percentage.                |
| `PROTOCOL_FEE_PCT`           | 1.0      | Protocol fee (1%) on sales, paid to the co-signing node. |
| `SUPPORTED_CURRENCIES`       | `HIVE`, `HBD` | Accepted payment currencies.          |
| `MIN_PRICE_AMOUNT`           | `0.001`  | Minimum listing price.                     |
| `SAFE_PAYLOAD_MAX_BYTES`     | 7372     | Max payload size (8KB with 10% margin).    |
| `MAX_SCHEMA_FIELDS`          | 64       | Max fields in a collection schema.         |

---

## Core Operations

### POST /api/build/collection

Create a new NFT collection with optional typed schema.

**Request Body:**

| Field                        | Type      | Required | Description                                           |
|------------------------------|-----------|----------|-------------------------------------------------------|
| `name`                       | `string`  | Yes      | Collection name (1-100 chars).                        |
| `symbol`                     | `string`  | Yes      | Collection symbol (3-8 chars, A-Z0-9).                |
| `creator`                    | `string`  | Yes      | Hive username of the creator.                         |
| `totalPotential`             | `number`  | Yes      | Max number of seeds in the collection (0 = unlimited). Cap on seed count, not instance supply. |
| `metadata.description`       | `string`  | Yes      | Collection description (1-250 chars).                 |
| `metadata.image`             | `string`  | Yes      | Collection image URL (valid URL, max 500 chars).      |
| `metadata.externalUrl`       | `string`  | No       | External website URL.                                 |
| `rules.transferable`         | `boolean` | Yes      | Whether NFTs can be transferred.                      |
| `rules.burnable`             | `boolean` | Yes      | Whether NFTs can be burned.                           |
| `rules.replicable`           | `boolean` | Yes      | Whether NFTs can be replicated.                       |
| `rules.royaltyPct`           | `number`  | Yes      | Royalty percentage on secondary sales (0-50).         |
| `rules.royaltyRecipient`     | `string`  | No       | Hive account receiving royalties.                     |
| `schema`                     | `object`  | No       | Typed schema definition.                              |
| `schema.immutable`           | `array`   | No       | Immutable field definitions `[{ name, type }]`.       |
| `schema.mutable`             | `array`   | Yes*     | Mutable field definitions (at least 1 if schema set). |

*Required only when `schema` is provided.

Schema field types: `string`, `bool`, `uint8`, `uint16`, `uint32`, `uint64`, `int8`, `int16`, `int32`, `int64`, `float`, `double`, and their array variants (`string[]`, `uint32[]`, etc.).

**Response** (additional fields):

| Field          | Type     | Description                                    |
|----------------|----------|------------------------------------------------|
| `collectionId` | `string` | Deterministic collection ID.                   |
| `generatedIds` | `object` | `{ collectionId: string, originDna: string }`. |

**curl example:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/collection \
	-H "Content-Type: application/json" \
	-d '{
		"name": "Dragon Cards",
		"symbol": "DRGN",
		"creator": "alice",
		"totalPotential": 1000,
		"metadata": {
			"description": "A collection of dragon trading cards",
			"image": "https://example.com/dragons.png"
		},
		"rules": {
			"transferable": true,
			"burnable": true,
			"replicable": true,
			"royaltyPct": 5,
			"royaltyRecipient": "alice"
		}
	}'
```

---

### POST /api/build/seeds

Mint seed NFTs for a collection. Returns operations batched into groups of up to 5 (Hive transaction limit).

**Request Body:**

| Field                  | Type     | Required | Description                                     |
|------------------------|----------|----------|-------------------------------------------------|
| `collectionId`         | `string` | Yes      | Target collection ID.                           |
| `owner`                | `string` | Yes      | Hive username of the collection creator. Signs the transaction and receives the seeds. Must be the account that created the collection. |
| `seeds`                | `array`  | Yes      | Array of seed definitions (at least 1).         |
| `seeds[].artId`        | `string` | Yes      | Unique art identifier within the collection.    |
| `seeds[].name`         | `string` | Yes      | Seed name (1-100 chars).                        |
| `seeds[].imageUrl`     | `string` | Yes      | Image URL (valid URL, max 500 chars).           |
| `seeds[].maxSupply`    | `number` | Yes      | Maximum instances this seed can produce (>= 1). |
| `seeds[].brief`        | `string` | No       | Short description (max 250 chars).              |

**Response** (additional fields):

| Field                              | Type     | Description                                          |
|------------------------------------|----------|------------------------------------------------------|
| `collectionId`                     | `string` | The target collection.                               |
| `generatedIds`                     | `object` | Map of `artId -> seedId`.                            |
| `seeds`                            | `array`  | Each entry: `{ artId, seedId, operation }`.          |
| `batches`                          | `array`  | Operations grouped for Hive transactions.            |
| `batches[].batchNumber`            | `number` | 1-indexed batch number.                              |
| `batches[].operationCount`         | `number` | Number of operations in this batch.                  |
| `batches[].operations`             | `array`  | The Hive operations for this batch.                  |

**curl example:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/seeds \
	-H "Content-Type: application/json" \
	-d '{
		"collectionId": "col_abc123",
		"owner": "alice",
		"seeds": [
			{
				"artId": "fire-dragon",
				"name": "Fire Dragon",
				"imageUrl": "https://example.com/fire-dragon.png",
				"maxSupply": 100
			},
			{
				"artId": "ice-dragon",
				"name": "Ice Dragon",
				"imageUrl": "https://example.com/ice-dragon.png",
				"maxSupply": 50,
				"brief": "A rare ice dragon"
			}
		]
	}'
```

---

### POST /api/build/bulk-distribute

Distribute instances from seeds to a recipient. Creates NFT instances from existing seeds.

**Request Body:**

| Field                            | Type     | Required | Description                                                    |
|----------------------------------|----------|----------|----------------------------------------------------------------|
| `signer`                         | `string` | Yes      | Hive username signing the operation.                           |
| `to`                             | `string` | No       | Recipient Hive username (if omitted, distributed to signer).   |
| `items`                          | `array`  | Yes      | Seed items to distribute (1-50, no duplicate seedIds).         |
| `items[].seedId`                 | `string` | Yes      | Seed ID to distribute from.                                    |
| `items[].quantity`               | `number` | Yes      | Number of instances to create (>= 1).                          |
| `items[].originBlock`            | `number` | Yes      | Block number of the seed mint (>= 0).                          |
| `imageOverrides`                 | `object` | No       | Map of `seedId -> { imageUrl?, imageHash? }` overrides.        |
| `data`                           | `object` | No       | Arbitrary data to attach to distributed instances.             |

**Key type:** Posting

**curl example:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/bulk-distribute \
	-H "Content-Type: application/json" \
	-d '{
		"signer": "alice",
		"to": "bob",
		"items": [
			{ "seedId": "seed_abc", "quantity": 3, "originBlock": 12345 },
			{ "seedId": "seed_def", "quantity": 1, "originBlock": 12346 }
		]
	}'
```

---

### POST /api/build/transfer

Transfer an NFT instance to another Hive account.

**Request Body:**

| Field      | Type     | Required | Description                                          |
|------------|----------|----------|------------------------------------------------------|
| `nftId`    | `string` | Yes      | NFT instance ID.                                     |
| `from`     | `string` | Yes      | Current owner (Hive username).                       |
| `to`       | `string` | Yes      | Recipient (Hive username). Must differ from `from`.  |
| `imageUrl` | `string` | No       | Image URL for indexer verification (recommended).    |
| `imageHash`| `string` | No       | Pre-computed image hash.                             |
| `seedId`   | `string` | No       | Seed provenance ID.                                  |
| `seedTxId`  | `string` | No       | Seed's creation tx_id (anti-replay proof).                                |

**Key type:** Posting

---

### POST /api/build/burn

Permanently destroy an NFT instance.

**Request Body:**

| Field      | Type     | Required | Description                                          |
|------------|----------|----------|------------------------------------------------------|
| `nftId`    | `string` | Yes      | NFT instance ID.                                     |
| `owner`    | `string` | Yes      | Current owner (Hive username).                       |
| `imageUrl` | `string` | No       | Image URL for indexer verification (recommended).    |
| `imageHash`| `string` | No       | Pre-computed image hash.                             |
| `seedId`   | `string` | No       | Seed provenance ID.                                  |
| `seedTxId`  | `string` | No       | Seed's creation tx_id (anti-replay proof).                                |

**Key type:** Posting

---

### POST /api/build/replicate

Create a replica of an existing NFT instance (if the collection allows replication).

**Request Body:**

| Field               | Type     | Required | Description                               |
|---------------------|----------|----------|-------------------------------------------|
| `originalId`        | `string` | Yes      | ID of the NFT to replicate.               |
| `originDna`         | `string` | Yes      | Collection origin DNA.                    |
| `originalInstanceDna` | `string` | Yes    | Instance DNA of the original NFT.         |
| `newOwner`          | `string` | Yes      | Hive username of the replica owner.       |
| `currentOwner`      | `string` | Yes      | Hive username of the original NFT owner.  |

**Key type:** Posting

**curl example:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/replicate \
	-H "Content-Type: application/json" \
	-d '{
		"originalId": "nft_abc123",
		"originDna": "a1b2c3d4e5f67890",
		"originalInstanceDna": "12345678901234",
		"newOwner": "bob",
		"currentOwner": "alice"
	}'
```

---

### POST /api/build/set-data

Update the mutable data of an NFT instance. Only the collection creator can call this.

**Request Body:**

| Field         | Type     | Required | Description                                   |
|---------------|----------|----------|-----------------------------------------------|
| `nftId`       | `string` | Yes      | NFT instance ID.                              |
| `instanceDna` | `string` | Yes      | Instance DNA of the NFT.                      |
| `issuer`      | `string` | Yes      | Hive username of the collection creator.      |
| `data`        | `object` | No       | Key-value pairs to update (legacy format).    |
| `mutableData` | `object` | No       | Key-value pairs to update (schema format).    |

Note: The `issuer` field in the request body maps to `owner` internally (used as the signer for auth).

**Key type:** Posting

---

### POST /api/build/set-data-from

Update mutable data as an approved data operator.

**Request Body:**

| Field         | Type     | Required | Description                                   |
|---------------|----------|----------|-----------------------------------------------|
| `nftId`       | `string` | Yes      | NFT instance ID.                              |
| `instanceDna` | `string` | Yes      | Instance DNA of the NFT.                      |
| `operator`    | `string` | Yes      | Hive username of the approved operator.       |
| `data`        | `object` | No       | Key-value pairs to update (legacy format).    |
| `mutableData` | `object` | No       | Key-value pairs to update (schema format).    |
| `seedId`      | `string` | No       | Seed provenance ID.                           |
| `seedTxId`     | `string` | No       | Seed's creation tx_id (anti-replay proof).                         |

**Key type:** Posting

---

### POST /api/build/set-owner-data

Update owner-specific data on an NFT instance. Only the current owner can call this. Owner data is separate from mutable data (which is controlled by the collection creator).

**Request Body:**

| Field         | Type     | Required | Description                                   |
|---------------|----------|----------|-----------------------------------------------|
| `nftId`       | `string` | Yes      | NFT instance ID.                              |
| `instanceDna` | `string` | Yes      | Instance DNA of the NFT.                      |
| `owner`       | `string` | Yes      | Hive username of the current NFT owner.       |
| `ownerData`   | `object` | Yes      | Key-value pairs to update (owner-specific).   |

**Key type:** Posting

---

### POST /api/build/extend-schema

Add new fields to an existing collection schema. Only the collection creator can extend the schema. Existing fields cannot be modified or removed.

**Request Body:**

| Field                | Type    | Required | Description                                    |
|----------------------|---------|----------|------------------------------------------------|
| `collectionId`       | `string`| Yes      | Collection ID.                                 |
| `creator`            | `string`| Yes      | Hive username of the collection creator.       |
| `newImmutableFields` | `array` | No       | New immutable field definitions to add.        |
| `newMutableFields`   | `array` | No       | New mutable field definitions to add.          |

At least one of `newImmutableFields` or `newMutableFields` must be provided.

**Key type:** Posting

---

### POST /api/build/data-operator-approve

Approve or revoke a data operator for a collection. Only the collection creator can call this.

**Request Body:**

| Field          | Type      | Required | Description                                    |
|----------------|-----------|----------|------------------------------------------------|
| `collectionId` | `string`  | Yes      | Collection ID.                                 |
| `operator`     | `string`  | Yes      | Hive username to approve/revoke.               |
| `approved`     | `boolean` | Yes      | `true` to approve, `false` to revoke.          |
| `creator`      | `string`  | Yes      | Hive username of the collection creator.       |

Note: The `creator` field in the request body maps to `owner` internally.

**Key type:** Posting

---

### POST /api/build/preview-ids

Preview deterministic IDs without creating any operation. Useful for pre-computing collection and seed IDs.

**Request Body:**

| Field    | Type       | Required | Description                          |
|----------|------------|----------|--------------------------------------|
| `creator`| `string`   | Yes      | Hive username of the creator.        |
| `name`   | `string`   | Yes      | Collection name.                     |
| `symbol` | `string`   | Yes      | Collection symbol.                   |
| `artIds` | `string[]` | No       | Array of artIds to preview seedIds.  |

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.4.0",
	"hashVersion": "v1",
	"collectionId": "col_...",
	"originDna": "...",
	"seedIds": {
		"fire-dragon": "seed_...",
		"ice-dragon": "seed_..."
	}
}
```

---

## Marketplace

### POST /api/build/list

List an NFT for sale on the marketplace.

**Request Body:**

| Field        | Type     | Required | Description                                                     |
|--------------|----------|----------|-----------------------------------------------------------------|
| `nftId`      | `string` | Yes      | NFT instance ID.                                                |
| `owner`      | `string` | Yes      | Hive username of the NFT owner.                                 |
| `price`      | `object` | Yes      | Price object.                                                   |
| `price.amount` | `string` | Yes    | Price in Hive decimal format (e.g. `"1.000"`). Min `"0.001"`.  |
| `price.currency` | `string` | Yes  | `"HIVE"` or `"HBD"`.                                           |
| `expiresAt`  | `number` | No       | Unix timestamp (ms) for listing expiration. Must be in future.  |
| `imageUrl`   | `string` | No       | Image URL for indexer verification.                             |
| `imageHash`  | `string` | No       | Pre-computed image hash.                                        |
| `marketplace`| `string` | No       | Marketplace identifier (metadata only, not used for fee routing). |
| `seedId`     | `string` | No       | Seed provenance ID.                                             |
| `seedTxId`    | `string` | No       | Seed's creation tx_id (anti-replay proof).                                           |

**Key type:** Posting

**curl example:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/list \
	-H "Content-Type: application/json" \
	-d '{
		"nftId": "nft_abc123",
		"owner": "alice",
		"price": { "amount": "10.000", "currency": "HIVE" }
	}'
```

---

### POST /api/build/unlist

Remove an NFT listing from the marketplace.

**Request Body:**

| Field      | Type     | Required | Description                                       |
|------------|----------|----------|---------------------------------------------------|
| `nftId`    | `string` | Yes      | NFT instance ID.                                  |
| `owner`    | `string` | Yes      | Hive username of the NFT owner.                   |
| `imageUrl` | `string` | No       | Image URL for indexer verification.               |
| `imageHash`| `string` | No       | Pre-computed image hash.                          |

**Key type:** Posting

---

### POST /api/build/buy

Buy a listed NFT. Returns multiple Hive operations: a `custom_json` payload plus HIVE/HBD transfer operations for seller, royalty recipient, and protocol fee (1%).

**Request Body:**

| Field                               | Type      | Required | Description                              |
|-------------------------------------|-----------|----------|------------------------------------------|
| `nftId`                             | `string`  | Yes      | NFT instance ID.                         |
| `listingId`                         | `string`  | Yes      | Deterministic listing ID from the list operation. |
| `listTxId`                          | `string`  | Yes      | Hive tx hash (40-char hex) of the list operation. |
| `buyer`                             | `string`  | Yes      | Hive username of the buyer.              |
| `seller`                            | `string`  | Yes      | Hive username of the seller.             |
| `nodeAccount`                       | `string`  | Yes      | Hive username of the co-signing node.    |
| `paymentSplit`                      | `object`  | Yes      | Pre-computed payment breakdown.          |
| `paymentSplit.sellerAmount`         | `number`  | Yes      | Amount going to seller (>= 0).           |
| `paymentSplit.royaltyAmount`        | `number`  | Yes      | Amount going to royalty recipient (>= 0).|
| `paymentSplit.royaltyRecipient`     | `string\|null` | Yes | Royalty recipient account or null.       |
| `paymentSplit.feeAmount`            | `number`  | Yes      | Protocol fee amount (1%, >= 0).          |
| `paymentSplit.feeAccount`           | `string`  | Yes      | Protocol fee account (co-signing node).  |
| `paymentSplit.totalPrice`           | `number`  | Yes      | Total price (> 0).                       |
| `paymentSplit.currency`             | `string`  | Yes      | `"HIVE"` or `"HBD"`.                    |

**Response** (note: uses `hiveOperations` instead of `operation`):

```json
{
	"success": true,
	"protocolVersion": "0.4.0",
	"hiveOperations": [
		["transfer", { "from": "buyer", "to": "seller", "amount": "9.900 HIVE", "memo": "NFTLox BUY:nft_abc" }],
		["transfer", { "from": "buyer", "to": "nftlox", "amount": "0.100 HIVE", "memo": "NFTLox FEE:nft_abc" }],
		["custom_json", { "required_auths": ["nftlox"], "json": "{...listingId, listTxId...}" }]
	],
	"payload": { ... }
}
```

**Key type:** Active (the transfer operations require active key)

---

## Packs

### POST /api/build/pack-create

Create a new pack definition for a collection.

**Request Body:**

| Field                       | Type     | Required | Description                                       |
|-----------------------------|----------|----------|---------------------------------------------------|
| `collectionId`              | `string` | Yes      | Collection ID the pack belongs to.                |
| `creator`                   | `string` | Yes      | Hive username of the collection creator.          |
| `name`                      | `string` | Yes      | Pack name (1-100 chars).                          |
| `description`               | `string` | No       | Pack description (max 250 chars).                 |
| `imageUrl`                  | `string` | No       | Pack image URL (max 500 chars).                   |
| `dropTable`                 | `array`  | Yes      | Drop table entries (1-50 entries).                |
| `dropTable[].seedId`        | `string` | Yes      | Seed ID that can drop from this pack.             |
| `dropTable[].weight`        | `number` | Yes      | Drop weight (1-10000). Higher = more likely.      |
| `itemsPerPack`              | `number` | Yes      | Items revealed per pack (1-20).                   |
| `price`                     | `object` | No       | Pack price `{ amount, currency }`.                |
| `price.amount`              | `string` | No       | Price in Hive decimal format (e.g. `"5.000"`).    |
| `price.currency`            | `string` | No       | `"HIVE"` or `"HBD"`.                             |
| `maxSupply`                 | `number` | Yes      | Maximum packs available (>= 0, 0 = unlimited).    |

**Response** (additional fields):

| Field    | Type     | Description                     |
|----------|----------|---------------------------------|
| `packId` | `string` | Deterministic pack ID.          |

**Key type:** Posting

**curl example:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/pack-create \
	-H "Content-Type: application/json" \
	-d '{
		"collectionId": "col_abc123",
		"creator": "alice",
		"name": "Dragon Booster Pack",
		"itemsPerPack": 5,
		"maxSupply": 1000,
		"dropTable": [
			{ "seedId": "seed_fire", "weight": 7000 },
			{ "seedId": "seed_ice", "weight": 3000 }
		],
		"price": { "amount": "5.000", "currency": "HIVE" }
	}'
```

---

### POST /api/build/pack-buy

Buy packs from a collection.

**Request Body:**

| Field      | Type     | Required | Description                            |
|------------|----------|----------|----------------------------------------|
| `packId`   | `string` | Yes      | Pack definition ID.                    |
| `buyer`    | `string` | Yes      | Hive username of the buyer.            |
| `quantity` | `number` | Yes      | Number of packs to buy (1-50).         |

**Key type:** Posting

---

### POST /api/build/pack-open

Open owned packs to reveal NFT instances.

**Request Body:**

| Field      | Type     | Required | Description                            |
|------------|----------|----------|----------------------------------------|
| `packId`   | `string` | Yes      | Pack definition ID.                    |
| `owner`    | `string` | Yes      | Hive username of the pack owner.       |
| `quantity` | `number` | Yes      | Number of packs to open (1-50).        |

**Key type:** Posting

---

### POST /api/build/pack-transfer

Transfer packs to another account.

**Request Body:**

| Field      | Type     | Required | Description                                        |
|------------|----------|----------|----------------------------------------------------|
| `packId`   | `string` | Yes      | Pack definition ID.                                |
| `from`     | `string` | Yes      | Current pack owner (Hive username).                |
| `to`       | `string` | Yes      | Recipient (Hive username). Must differ from `from`.|
| `quantity` | `number` | Yes      | Number of packs to transfer (>= 1).               |

**Key type:** Posting

---

## Allowances

### POST /api/build/nft-approve

Approve or revoke a spender for a specific NFT instance.

**Request Body:**

| Field        | Type      | Required | Description                                    |
|--------------|-----------|----------|------------------------------------------------|
| `owner`      | `string`  | Yes      | Hive username of the NFT owner.                |
| `spender`    | `string`  | Yes      | Hive username to approve/revoke.               |
| `instanceId` | `string`  | Yes      | NFT instance ID.                               |
| `approved`   | `boolean` | Yes      | `true` to approve, `false` to revoke.          |

**Key type:** Posting

---

### POST /api/build/nft-approve-all

Approve or revoke a spender for all NFTs in a collection owned by the signer.

**Request Body:**

| Field          | Type      | Required | Description                                    |
|----------------|-----------|----------|------------------------------------------------|
| `owner`        | `string`  | Yes      | Hive username of the NFT owner.                |
| `spender`      | `string`  | Yes      | Hive username to approve/revoke.               |
| `collectionId` | `string`  | Yes      | Collection ID scope.                           |
| `approved`     | `boolean` | Yes      | `true` to approve, `false` to revoke.          |

**Key type:** Posting

---

### POST /api/build/nft-transfer-from

Transfer an NFT as an approved spender (operator).

**Request Body:**

| Field        | Type     | Required | Description                                   |
|--------------|----------|----------|-----------------------------------------------|
| `spender`    | `string` | Yes      | Hive username of the approved operator.       |
| `from`       | `string` | Yes      | Current NFT owner (Hive username).            |
| `to`         | `string` | Yes      | Recipient (Hive username).                    |
| `instanceId` | `string` | Yes      | NFT instance ID.                              |
| `seedId`     | `string` | No       | Seed provenance ID.                           |
| `seedTxId`    | `string` | No       | Seed's creation tx_id (anti-replay proof).                         |

Note: The `spender` field in the request body maps to `operator` internally.

**Key type:** Posting

---

### POST /api/build/pack-approve

Approve or revoke a spender for packs.

**Request Body:**

| Field      | Type      | Required | Description                                    |
|------------|-----------|----------|------------------------------------------------|
| `owner`    | `string`  | Yes      | Hive username of the pack owner.               |
| `spender`  | `string`  | Yes      | Hive username to approve/revoke.               |
| `packId`   | `string`  | Yes      | Pack definition ID.                            |
| `quantity` | `number`  | Yes      | Number of packs approved (>= 1).               |
| `approved` | `boolean` | Yes      | `true` to approve, `false` to revoke.          |

**Key type:** Posting

---

### POST /api/build/pack-transfer-from

Transfer packs as an approved spender (operator).

**Request Body:**

| Field      | Type     | Required | Description                                    |
|------------|----------|----------|------------------------------------------------|
| `spender`  | `string` | Yes      | Hive username of the approved operator.        |
| `from`     | `string` | Yes      | Current pack owner (Hive username).            |
| `to`       | `string` | Yes      | Recipient (Hive username).                     |
| `packId`   | `string` | Yes      | Pack definition ID.                            |
| `quantity` | `number` | Yes      | Number of packs to transfer (>= 1).            |

Note: The `spender` field in the request body maps to `operator` internally.

**Key type:** Posting

---

## Lending

### POST /api/build/nft-lend

Lend an NFT to another account. The borrower gets temporary custody but cannot transfer, sell, or burn the NFT.

**Request Body:**

| Field        | Type     | Required | Description                                       |
|--------------|----------|----------|---------------------------------------------------|
| `owner`      | `string` | Yes      | Hive username of the NFT owner (lender).          |
| `instanceId` | `string` | Yes      | NFT instance ID to lend.                          |
| `borrower`   | `string` | Yes      | Hive username of the borrower. Must differ from owner. |
| `seedId`     | `string` | No       | Seed provenance ID.                               |
| `seedTxId`    | `string` | No       | Seed's creation tx_id (anti-replay proof).                             |

**Key type:** Posting

---

### POST /api/build/nft-return

Return a lent NFT to its owner. Can be called by the borrower or the owner.

**Request Body:**

| Field        | Type     | Required | Description                                       |
|--------------|----------|----------|---------------------------------------------------|
| `signer`     | `string` | Yes      | Hive username of the signer (borrower or owner).  |
| `instanceId` | `string` | Yes      | NFT instance ID to return.                        |
| `seedId`     | `string` | No       | Seed provenance ID.                               |
| `seedTxId`    | `string` | No       | Seed's creation tx_id (anti-replay proof).                             |

Note: The `signer` field in the request body maps to `owner` internally.

**Key type:** Posting

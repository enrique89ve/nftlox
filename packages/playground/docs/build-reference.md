# Build API Reference

## Overview

The Build API constructs unsigned Hive `custom_json` operations for the NFTLox protocol. It does **not** broadcast transactions -- the client is responsible for signing the returned operations with the appropriate Hive key and broadcasting them to the blockchain.

Each endpoint validates input, generates deterministic IDs where applicable, and returns a ready-to-sign Hive operation payload.

**Base URL:** `https://nftloxtest.hivecreators.co` (playground server). This is not the production indexer.

**Protocol version:** `0.3.0`

---

## Response Format

All endpoints return JSON with the following standard shape:

```json
{
	"success": true,
	"protocolVersion": "0.3.0",
	"operation": ["custom_json", { ... }],
	"payload": { "protocol": "nftlox_testnet", "version": "0.3.0", "action": "...", "data": { ... } },
	"keyType": "Posting"
}
```

| Field             | Type       | Description                                                                 |
|-------------------|------------|-----------------------------------------------------------------------------|
| `success`         | `boolean`  | Whether the build succeeded.                                                |
| `protocolVersion` | `string`   | Protocol version used (`0.3.0`).                                            |
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
| `PROTOCOL_FEE_PCT`           | 2.5      | Protocol fee on marketplace sales.         |
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
| `jsonId`                     | `string`  | Yes      | Unique JSON identifier for indexing.                  |
| `name`                       | `string`  | Yes      | Collection name (1-100 chars).                        |
| `symbol`                     | `string`  | Yes      | Collection symbol (3-8 chars, A-Z0-9).                |
| `creator`                    | `string`  | Yes      | Hive username of the creator.                         |
| `totalPotential`             | `number`  | Yes      | Total potential instances across all seeds (>= 0).    |
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
		"jsonId": "json_abc123",
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
| `owner`                | `string` | Yes      | Hive username of the seed owner.                |
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
| `birthTx`  | `string` | No       | Birth transaction ID.                                |

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
| `birthTx`  | `string` | No       | Birth transaction ID.                                |

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

**Key type:** Active

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
| `birthTx`     | `string` | No       | Birth transaction ID.                         |

**Key type:** Active

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

**Key type:** Active

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
	"protocolVersion": "0.3.0",
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
| `marketplace`| `string` | No       | Marketplace identifier for filtering.                           |
| `seedId`     | `string` | No       | Seed provenance ID.                                             |
| `birthTx`    | `string` | No       | Birth transaction ID.                                           |

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

Buy a listed NFT. Returns multiple Hive operations: a `custom_json` payload plus HIVE/HBD transfer operations for seller, royalty recipient, and protocol fee.

**Request Body:**

| Field                               | Type      | Required | Description                              |
|-------------------------------------|-----------|----------|------------------------------------------|
| `nftId`                             | `string`  | Yes      | NFT instance ID.                         |
| `buyer`                             | `string`  | Yes      | Hive username of the buyer.              |
| `seller`                            | `string`  | Yes      | Hive username of the seller.             |
| `paymentSplit`                      | `object`  | Yes      | Pre-computed payment breakdown.          |
| `paymentSplit.sellerAmount`         | `number`  | Yes      | Amount going to seller (>= 0).           |
| `paymentSplit.royaltyAmount`        | `number`  | Yes      | Amount going to royalty recipient (>= 0).|
| `paymentSplit.royaltyRecipient`     | `string\|null` | Yes | Royalty recipient account or null.       |
| `paymentSplit.feeAmount`            | `number`  | Yes      | Protocol fee amount (>= 0).             |
| `paymentSplit.feeAccount`           | `string`  | Yes      | Protocol fee account.                    |
| `paymentSplit.totalPrice`           | `number`  | Yes      | Total price (> 0).                       |
| `paymentSplit.currency`             | `string`  | Yes      | `"HIVE"` or `"HBD"`.                    |
| `seedId`                            | `string`  | No       | Seed provenance ID.                      |
| `birthTx`                           | `string`  | No       | Birth transaction ID.                    |

**Response** (note: uses `hiveOperations` instead of `operation`):

```json
{
	"success": true,
	"protocolVersion": "0.3.0",
	"hiveOperations": [
		["custom_json", { ... }],
		["transfer", { "from": "buyer", "to": "seller", "amount": "9.750 HIVE", "memo": "NFTLox BUY:nft_abc" }],
		["transfer", { "from": "buyer", "to": "nftlox", "amount": "0.250 HIVE", "memo": "NFTLox FEE:nft_abc" }]
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

**Key type:** Active

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

**Key type:** Active

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
| `birthTx`    | `string` | No       | Birth transaction ID.                         |

Note: The `spender` field in the request body maps to `operator` internally.

**Key type:** Active

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

**Key type:** Active

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

**Key type:** Active

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
| `birthTx`    | `string` | No       | Birth transaction ID.                             |

**Key type:** Active

---

### POST /api/build/nft-return

Return a lent NFT to its owner. Can be called by the borrower or the owner.

**Request Body:**

| Field        | Type     | Required | Description                                       |
|--------------|----------|----------|---------------------------------------------------|
| `signer`     | `string` | Yes      | Hive username of the signer (borrower or owner).  |
| `instanceId` | `string` | Yes      | NFT instance ID to return.                        |
| `seedId`     | `string` | No       | Seed provenance ID.                               |
| `birthTx`    | `string` | No       | Birth transaction ID.                             |

Note: The `signer` field in the request body maps to `owner` internally.

**Key type:** Active

# Collections

A collection is the top-level container in NFTLox. Every NFT (seed or instance) belongs to exactly one collection. This page covers the full lifecycle: creation, schema definition, schema extension, and archival.

```
create_collection ──► ACTIVE ──► extend_schema (repeatable)
                        │
                        └──► archive_collection ──► ARCHIVED
```

---

## 1. Creating a Collection

A `create_collection` operation registers the collection on-chain. The collection ID is **deterministic** -- the same `creator + name + symbol` always produces the same ID (prevents duplicates).

### Required Fields

| Field | Type | Constraints |
|---|---|---|
| `name` | string | 1--100 characters |
| `symbol` | string | 3--8 uppercase alphanumeric (`A-Z`, `0-9`) |
| `creator` | string | Valid Hive username (signer) |
| `totalPotential` | number | Non-negative integer (0 = unlimited) |
| `metadata.description` | string | 1--250 characters |
| `metadata.image` | string | Valid HTTP/HTTPS URL, max 500 chars |
| `rules` | object | See [Collection Rules](#2-collection-rules) |

### Optional Fields

| Field | Type | Description |
|---|---|---|
| `metadata.externalUrl` | string | Project website URL |
| `schema` | object | Typed schema for NFT data (see [Schema Definition](#3-schema-definition)) |

### Schema Versioning at Creation

When a collection is created, it receives a `schema_version`:
- **0** if no schema is provided at creation.
- **1** if a schema is provided at creation.

Each subsequent `extend_schema` call increments the version (see [Extending a Schema](#4-extending-a-schema)).

### SDK Builder

```typescript
import { buildCollection } from "@nftlox/sdk";

const result = await buildCollection({
	name: "My Collection",
	symbol: "MYCOL",
	creator: "game-admin",
	totalPotential: 1000,
	metadata: {
		description: "Collection for game assets",
		image: "https://example.com/collection.webp",
	},
	rules: {
		transferable: true,
		burnable: true,
		royaltyPct: 5,
		royaltyRecipient: "game-treasury",
	},
	schema: {
		immutable: [
			{ name: "rarity", type: "string" },
			{ name: "base_power", type: "uint16" },
		],
		mutable: [
			{ name: "level", type: "uint8" },
			{ name: "xp", type: "uint32" },
		],
	},
});

if (result.success) {
	console.log(result.generatedIds.collectionId); // deterministic ID
	console.log(result.generatedIds.originDna);     // origin DNA hash
	console.log(result.operation);                   // ready-to-sign Hive operation
	console.log(result.warnings);                    // optional warnings
}
```

The builder returns warnings (not errors) for edge cases:
- Name close to 100-char limit
- Royalty percentage above 25%

### Build API

```bash
curl -X POST https://api-nftlox.hivecreators.co/api/build/collection \
	-H "Content-Type: application/json" \
	-d '{
		"name": "My Collection",
		"symbol": "MYCOL",
		"creator": "game-admin",
		"totalPotential": 1000,
		"metadata": {
			"description": "Collection for game assets",
			"image": "https://example.com/collection.webp"
		},
		"rules": {
			"transferable": true,
			"burnable": true,
			"royaltyPct": 5
		}
	}'
```

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.6.0",
	"collectionId": "a1b2c3d4...",
	"generatedIds": {
		"collectionId": "a1b2c3d4...",
		"originDna": "e5f6a7b8..."
	},
	"operation": ["custom_json", { ... }],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.6.0",
		"action": "create_collection",
		"data": { ... }
	}
}
```

### Indexer Behavior

On processing `create_collection`:

1. Validates the collection ID does not already exist (idempotent -- duplicate broadcasts are silently ignored).
2. Validates the schema definition if provided (field names, types, limits).
3. Stores the collection with `status = active`.
4. Sets `schema_version = 1` if a schema was provided, or `schema_version = 0` if not.
5. If a schema is provided, creates the first entry in the `schema_versions` hash chain (version 1, full schema JSONB, SHA-256 hash, `prev_hash = null`).
6. The `creator` is always derived from the transaction signer, not from the payload body.

---

## 2. Collection Rules

Rules are set at creation time and cannot be changed afterward.

| Rule | Type | Default | Description |
|---|---|---|---|
| `transferable` | bool | `true` | Whether NFTs in this collection can be transferred between owners |
| `burnable` | bool | `true` | Whether NFTs can be permanently destroyed |
| `royaltyPct` | number | `0` | Royalty percentage on marketplace sales (0--50) |
| `royaltyRecipient` | string | -- | Hive account that receives royalty payments |

### Design Notes

- Setting `transferable: false` creates soulbound tokens -- they stay with the minting owner forever.
- Setting `burnable: false` makes NFTs permanent -- useful for certifications or credentials.
- `royaltyPct` is enforced by the protocol on marketplace sales. Maximum is 50%. Values above 25% trigger a builder warning.

---

## 3. Schema Definition

A schema defines **typed fields** for NFT data within the collection. It has two sections:

| Section | Behavior | Set at | Updated by |
|---|---|---|---|
| `immutable` | Locked at mint time, never changes | Mint | -- (read-only) |
| `mutable` | Can be updated after mint | Mint (optional) | Creator or approved data operators |

### Field Types and Constraints

For complete list of supported field types (scalar and array), validation rules, and constraints, see [Data Formats Reference](../data-formats.md#schema-definition).

### Field Name Rules

- Must start with a lowercase letter
- Only lowercase letters, digits, and underscores: `/^[a-z][a-z0-9_]*$/`
- Maximum 64 characters
- Must be unique across both `immutable` and `mutable` sections
- Maximum 64 total fields per schema

### Schema Builder (Fluent API)

```typescript
import { createSchemaBuilder } from "@nftlox/sdk";

const schema = createSchemaBuilder()
	.immutable("rarity", "string")
	.immutable("base_power", "uint16")
	.immutable("keywords", "string[]")
	.mutable("level", "uint8")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.build();
```

### Pre-built Templates

The SDK includes ready-to-use templates for common use cases:

| Template | Immutable Fields | Mutable Fields | Use Case |
|---|---|---|---|
| `GAMING_SCHEMA` | rarity, element, base_power, class | level, xp, health, wins, losses, equipped | RPG items |
| `ART_SCHEMA` | artist, medium, year, edition_of, dimensions | exhibition, certificate_url | Digital art |
| `COLLECTIBLE_SCHEMA` | rarity, series, card_number, total_in_series | condition, grade | Trading cards |
| `MUSIC_SCHEMA` | artist, album, track_number, duration_seconds, genre | play_count, license_url | Music NFTs |

```typescript
import { GAMING_SCHEMA } from "@nftlox/sdk";

const result = await buildCollection({
	name: "My Game Items",
	symbol: "ITEMS",
	creator: "game-account",
	totalPotential: 10000,
	metadata: {
		description: "In-game equipment and weapons",
		image: "https://example.com/items.webp",
	},
	rules: {
		transferable: true,
		burnable: true,
		royaltyPct: 0,
	},
	schema: GAMING_SCHEMA,
});
```

---

## 4. Extending a Schema

Use `extend_schema` to **append new fields** to an existing collection's schema. This is an append-only operation -- existing fields cannot be removed or modified. Each call increments the collection's `schema_version` and appends a new entry to the `schema_versions` hash chain.

### Schema Version Hash Chain

Every `extend_schema` creates a new record in the `schema_versions` table:

| Column | Description |
|---|---|
| `version` | Auto-incremented version number (2, 3, ...) |
| `schema` | Full schema JSONB at this version (all fields, not just the new ones) |
| `hash` | SHA-256 of the canonical JSON schema (via `computeDataHash`/`canonicalJson`) |
| `prev_hash` | Hash of the previous version, forming a linked chain |

This hash chain provides a tamper-evident audit trail of all schema changes.

### Constraints

- Only the collection **creator** can extend the schema.
- Collection must not be archived.
- New field names must not collide with existing field names.
- Total fields (existing + new) must not exceed 64.
- Each new field must pass the same validation rules as schema definition.
- At least one new field is required per operation.

### SDK Usage

```typescript
import { buildExtendSchema } from "@nftlox/sdk";

const result = buildExtendSchema({
	creator: "game-admin",
	collectionId: "a1b2c3d4...",
	newMutableFields: [
		{ name: "enchantments", type: "string[]" },
		{ name: "durability", type: "uint16" },
	],
});

if (result.success) {
	console.log(result.operation); // ready-to-sign (posting key)
	console.log(result.payload);
}
```

### Build API

```bash
curl -X POST https://api-nftlox.hivecreators.co/api/build/extend-schema \
	-H "Content-Type: application/json" \
	-d '{
		"creator": "game-admin",
		"collectionId": "a1b2c3d4...",
		"newMutableFields": [
			{ "name": "durability", "type": "uint16" }
		]
	}'
```

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.6.0",
	"operation": ["custom_json", { ... }],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.6.0",
		"action": "extend_schema",
		"data": {
			"collectionId": "a1b2c3d4...",
			"newMutableFields": [
				{ "name": "durability", "type": "uint16" }
			]
		}
	},
	"keyType": "Posting"
}
```

### Indexer Behavior

On processing `extend_schema`:

1. Verifies the signer is the collection creator.
2. Verifies the collection is not archived.
3. If the collection already has a schema, merges new fields using `mergeSchemas()` -- checks for name collisions, validates types, enforces the 64-field cap.
4. If the collection has no schema yet, creates a new one from the provided fields and validates it.
5. Increments `schema_version` on the collection.
6. Inserts a new `schema_versions` row with the full merged schema, its SHA-256 hash, and `prev_hash` linking to the previous version.

### NFTs and Schema Versions

NFTs store the collection's `schema_version` at the time they are minted. This value is **immutable** -- it records under which schema rules the NFT was created. However, `set_data` always validates against the collection's **current** schema (not the NFT's birth schema). This is safe because `extend_schema` is append-only: version N always contains all fields from version N-1 plus new ones. An NFT born under v1 can receive v2 fields via `set_data`, but its `schema_version` stays at 1.

---

## 5. Archiving a Collection

`archive_collection` permanently closes a collection. Archived collections cannot mint new NFTs or extend their schema.

### Preconditions

All of the following must be true:

- The signer must be the collection **creator**.
- The collection must not already be archived.
- The collection must have **0 NFTs** remaining (all burned or otherwise removed).

### What Happens on Archive

1. All collection-level allowances are deleted (NFT approvals, data operator approvals).
2. All data operators for the collection are removed.
3. Collection status changes to `archived`.
4. The archive block number, tx ID, and timestamp are recorded.

### Existing Data

- The collection record itself is **not deleted** -- it remains queryable for historical reference.
- The archive is irreversible.

### SDK Usage

```typescript
import { buildArchiveCollection } from "@nftlox/sdk";

const result = buildArchiveCollection({
	creator: "game-admin",
	collectionId: "a1b2c3d4...",
});

if (result.success) {
	console.log(result.operation); // ready-to-sign (posting key)
	console.log(result.payload);
}
```

### Build API

```bash
curl -X POST https://api-nftlox.hivecreators.co/api/build/archive-collection \
	-H "Content-Type: application/json" \
	-d '{
		"creator": "game-admin",
		"collectionId": "a1b2c3d4..."
	}'
```

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.6.0",
	"operation": ["custom_json", { ... }],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.6.0",
		"action": "archive_collection",
		"data": {
			"collectionId": "a1b2c3d4..."
		}
	},
	"keyType": "Posting"
}
```

---

## 6. Seed Management & `totalPotential`

The `totalPotential` field defines the maximum number of **seeds** (unique art pieces) a collection can hold. Each seed can then be minted into multiple editions/instances.

| Value | Meaning |
|---|---|
| `0` | Unlimited -- no cap on seeds |
| `> 0` | Hard cap on the number of unique seeds |

Seed IDs are deterministic: `SHA-256(collectionId + artId)`. This prevents duplicate seeds within the same collection without requiring a global counter.

```
Collection (totalPotential: 3)
├── Seed "fire-sword"     (artId → deterministic seedId)
│   ├── Instance #1
│   └── Instance #2
├── Seed "ice-shield"
│   └── Instance #1
└── Seed "thunder-helm"   ← 3rd seed, cap reached
```

---

## 7. Ownership Provenance

For the full creator/owner cascade, see [Ownership Model](ownership.md).

NFTs include an `owner_operation_id` field plus a `previous_owner` field. Together they describe the current ownership edge without storing a full ownership history:

- **Set at mint / bulk distribute** with `previous_owner = null`.
- **Updated on transfer, buy, and transfer_from** with the outgoing owner in `previous_owner` and the canonical HafAH operation ID in `owner_operation_id`.

Anyone can look up the `owner_operation_id` on HafAH to see the full operation details (who sent what, when, and in which block). This provides a transparent, on-chain provenance trail for the current owner without requiring the indexer to store a full ownership history.

```bash
# Get an NFT and check its ownership provenance
curl https://api-nftlox.hivecreators.co/api/nfts/nft_a1b2c3d4_1_ef56

# Response includes:
# "owner": "new-owner",
# "previous_owner": "old-owner",
# "owner_operation_id": "1234567890"
#
# Then verify on HafAH:
# https://hafah.hivehub.dev/hafah-api/operations/1234567890
```

---

## 8. Query API

### GET /api/collections

List collections with optional filtering.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `creator` | string | -- | Filter by creator username |
| `limit` | number | 50 | Results per page (1--200) |
| `offset` | number | 0 | Pagination offset |

```bash
curl "https://api-nftlox.hivecreators.co/api/collections?creator=game-admin&limit=10"
```

### GET /api/collections/:id

Get a single collection by its deterministic ID. Returns the full object including metadata, rules, schema, and timestamps.

```bash
curl https://api-nftlox.hivecreators.co/api/collections/a1b2c3d4...
```

### GET /api/collections/:id/nfts

List NFTs belonging to a collection. Supports `type` filter (`seed`, `instance`).

```bash
curl "https://api-nftlox.hivecreators.co/api/collections/a1b2c3d4.../nfts?type=seed&limit=20"
```

### GET /api/collections/:id/schema-history

Returns the full schema version hash chain for a collection. Each entry includes the version number, full schema JSONB, SHA-256 hash, and `prev_hash`.

```bash
curl https://api-nftlox.hivecreators.co/api/collections/a1b2c3d4.../schema-history
```

**Response:**

```json
{
	"collectionId": "a1b2c3d4...",
	"versions": [
		{
			"version": 1,
			"schema": { "immutable": [...], "mutable": [...] },
			"hash": "sha256-of-v1...",
			"prev_hash": null
		},
		{
			"version": 2,
			"schema": { "immutable": [...], "mutable": [...] },
			"hash": "sha256-of-v2...",
			"prev_hash": "sha256-of-v1..."
		}
	]
}
```

### GET /api/collections/:id/stats

Aggregated statistics: seed count, instance count, listed, burned, unique owners, floor price.

```bash
curl https://api-nftlox.hivecreators.co/api/collections/a1b2c3d4.../stats
```

---

## 9. Build API Summary

Most build endpoints return an unsigned Hive `custom_json` operation. Collection creation uses `/api/build/collection-multisig` so the node can co-sign the fee transaction.

| Endpoint | Action | Key Type |
|---|---|---|
| `POST /api/build/collection-multisig` | `create_collection` | Active |
| `POST /api/build/collection` | `create_collection` raw custom_json | Active |
| `POST /api/build/extend-schema` | `extend_schema` | Posting |
| `POST /api/build/archive-collection` | `archive_collection` | Posting |
| `POST /api/build/preview-ids` | (utility) Preview deterministic IDs | -- |

### Preview IDs

Utility endpoint to preview the deterministic collection ID, origin DNA, and seed IDs before creating anything on-chain.

```bash
curl -X POST https://api-nftlox.hivecreators.co/api/build/preview-ids \
	-H "Content-Type: application/json" \
	-d '{
		"creator": "game-admin",
		"name": "My Collection",
		"symbol": "MYCOL",
		"artIds": ["item-1", "item-2"]
	}'
```

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.6.0",
	"collectionId": "a1b2c3d4...",
	"originDna": "e5f6a7b8...",
	"seedIds": {
		"item-1": "seed-id-1...",
		"item-2": "seed-id-2..."
	}
}
```

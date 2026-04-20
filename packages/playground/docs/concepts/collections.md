# Collections

A collection is the top-level container in NFTLox. Every NFT (seed or instance) belongs to exactly one collection. This page covers the full lifecycle: creation, schema definition, schema extension, and archival.

```
create_collection ──► ACTIVE ──► extend_schema (repeatable)
                       │
                       └──► archive_collection ──► ARCHIVED
```

## 1. Creating a collection

A `create_collection` operation registers the collection on-chain. The collection ID is **deterministic**: `sha256(domain | creator | name | symbol)`, so the same `(creator, name, symbol)` triple always produces the same ID and duplicates are impossible.

### Signing model

`create_collection` is one of the protocol's **dual-signer** actions. The transaction contains:

- A `transfer` op (the creation fee, default `0.100 HBD`) signed by the creator's **active** key.
- A `custom_json` op with `required_auths: [nodeAccount]`, signed by the node's multisig key.

The fee transfer MUST carry memo `NFTLox FEE-COL:{collectionId}`. Transfers to the treasury without this memo are ignored by the indexer (since 0.6.0); any such transfer is treated as a voluntary gift, not a fee.

The node's signature is requested via `requestCreateCollectionMultisig(indexerBaseUrl, { transaction })`. See [Signing & Broadcasting](../broadcasting.md#2-create_collection--active--node-multisig) for the full flow.

### Required fields

| Field | Type | Constraints |
|---|---|---|
| `name` | string | 1–100 characters |
| `symbol` | string | 3–10 uppercase alphanumeric, must start with a letter (`/^[A-Z][A-Z0-9]{2,9}$/`) |
| `creator` | string | Valid Hive username (signer) |
| `totalPotential` | number | Non-negative integer (0 = unlimited seeds) |
| `maxInstances` | number | `0` (unlimited) **or** a positive multiple of `INSTANCE_FEE_PER_N` (`1000`). Caps total instances mintable across all seeds. Stored immutably; drives the scaled-fee math when `INSTANCE_FEE_ENABLED` is on. |
| `metadata.description` | string | 1–250 characters |
| `metadata.image` | string | HTTP/HTTPS URL, ≤ 500 chars |
| `rules` | object | See [Collection rules](#2-collection-rules) |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `metadata.externalUrl` | string | Project website URL |
| `schema` | object | Typed schema for NFT data ([section 3](#3-schema-definition)) |

### Schema versioning at creation

Every collection gets a `schema_version`:

- **0** if no schema is provided.
- **1** if a schema is provided. Subsequent `extend_schema` calls bump this to 2, 3, …

### SDK builder — `buildCollection`

```typescript
import { buildCollection, createSchemaBuilder } from "nftlox-sdk";

const INDEXER = "https://api-nftlox.hivecreators.co";

const result = await buildCollection(
	{
		name: "Heroes of Ragnarok",
		symbol: "HERO",
		creator: "ragnarok-studio",
		totalPotential: 1000,
		maxInstances: 0,              // 0 = unlimited; otherwise a multiple of 1000
		metadata: {
			description: "Playable hero cards",
			image: "https://…/cover.webp",
			externalUrl: "https://heroes.ragnarok.gg",
		},
		rules: {
			transferable: true,
			burnable: true,
			royaltyPct: 5,
			royaltyRecipient: "ragnarok-treasury",
		},
		schema: createSchemaBuilder()
			.immutable("rarity", "string")
			.immutable("base_power", "uint16")
			.mutable("level", "uint8")
			.mutable("xp", "uint32")
			.build(),
	},
	{ indexerBaseUrl: INDEXER, feeCurrency: "HBD", feeAmount: "0.100" },
);

if (!result.success) throw new Error(JSON.stringify(result.errors));

// result.operations       -> transfer + custom_json
// result.coSigners        -> [{ account: nodeAccount, keyType: "Active" }]
// result.generatedIds     -> { collectionId, originDna }
// result.payload          -> full ProtocolPayload<CollectionData>
// result.warnings?        -> close-to-limit name, royalty > 25%
```

For collections with seeds in the same ceremony, use [`buildCollectionWithSeeds`](../sdk/reference.md#buildcollectionwithseeds) — it plans the collection step and batches every seed `mint` op into right-sized transactions.

### Fee scaling (dormant)

The creation fee defaults to `PROTOCOL_COLLECTION_FEE_HBD` (`0.100 HBD`). A scaled adapter exists but is gated behind `INSTANCE_FEE_ENABLED` (currently `false`):

```
fee = PROTOCOL_COLLECTION_FEE_HBD + INSTANCE_FEE_UNIT_HBD * ceil(maxInstances / INSTANCE_FEE_PER_N)
    = 0.100 HBD         + 0.001 HBD          *           ceil(maxInstances / 1000)
```

While the flag is off, the fee is flat `0.100 HBD`. The **granularity rule on `maxInstances` (0 or multiple of 1000) is already enforced today**, so the payload is forward-compatible the moment the flag flips — no migration required. `feeAmount` in `buildCollection` options remains a manual override regardless.

### Indexer behaviour

On processing `create_collection`:

1. Rejects the op if the deterministic `collectionId` already exists (idempotent — a duplicate broadcast is a no-op).
2. Validates the schema if provided (field names match `/^[a-z][a-z0-9_]*$/`, types from the 24-type allowlist, ≤ 64 fields).
3. Inserts the collection with `status = active`.
4. Sets `schema_version = 1` with a schema (row 1 of the `schema_versions` hash chain, `prev_hash = null`), or `0` without.
5. The `creator` in the stored row comes from the **Hive transaction signer**, not the JSON payload — anyone who tries to spoof a different creator in the payload is rejected.

## 2. Collection rules

Set once at creation, frozen forever. Cannot be changed — not even by `extend_schema`.

| Rule | Type | Default | Description |
|---|---|---|---|
| `transferable` | bool | `true` | If `false`, NFTs are soulbound to the owner set at mint/distribute. |
| `burnable` | bool | `true` | If `false`, NFTs are permanent (credentials, proofs-of-attendance). |
| `royaltyPct` | number | `0` | Royalty % on marketplace sales. Range 0–50. Warning emitted above 25. |
| `royaltyRecipient` | string | — | Hive account receiving royalties. Required if `royaltyPct > 0`. |

## 3. Schema definition

A schema declares **typed fields** for NFT data. Two sections:

| Section | Behaviour | Written by | Read by |
|---|---|---|---|
| `immutable` | Locked at mint / bulk_distribute time, frozen forever | Creator (mint), distributor (bulk_distribute) | Anyone |
| `mutable` | Can be updated post-mint | Current owner (`set_data`), approved data operator (`set_data_from`) | Anyone |

Full type catalogue (scalars + arrays): see [Data Formats — schema types](../data-formats.md#schema-types).

### Field name rules

- Start with a lowercase letter; only `[a-z0-9_]` after that.
- `/^[a-z][a-z0-9_]*$/`, max 64 chars.
- Unique across both sections.
- Max 64 total fields per collection (immutable + mutable combined).

### Schema builder

```typescript
import { createSchemaBuilder } from "nftlox-sdk";

const schema = createSchemaBuilder()
	.immutable("rarity", "string")
	.immutable("base_power", "uint16")
	.immutable("keywords", "string[]")      // array types: {type}[]
	.mutable("level", "uint8")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.build();
```

### Pre-built templates

```typescript
import { GAMING_SCHEMA, ART_SCHEMA, COLLECTIBLE_SCHEMA, MUSIC_SCHEMA } from "nftlox-sdk";
```

| Template | Immutable | Mutable | Use case |
|---|---|---|---|
| `GAMING_SCHEMA` | rarity, element, base_power, class | level, xp, health, wins, losses, equipped | RPG items |
| `ART_SCHEMA` | artist, medium, year, edition_of, dimensions | exhibition, certificate_url | Digital art |
| `COLLECTIBLE_SCHEMA` | rarity, series, card_number, total_in_series | condition, grade | Trading cards |
| `MUSIC_SCHEMA` | artist, album, track_number, duration_seconds, genre | play_count, license_url | Music NFTs |

Pass a template directly as `schema:` in `buildCollection`. Combine with the builder if you want to add fields on top.

## 4. Extending a schema — `buildExtendSchema`

`extend_schema` **appends** fields (immutable and/or mutable) to an existing collection. Append-only: existing fields cannot be removed or retyped.

```typescript
import { buildExtendSchema } from "nftlox-sdk";

const result = buildExtendSchema({
	creator: "ragnarok-studio",               // must match collections.creator
	collectionId: "col_…",
	newMutableFields: [
		{ name: "enchantments", type: "string[]" },
		{ name: "durability", type: "uint16" },
	],
	// newImmutableFields also supported (written on future mints/distributes)
});
```

### Version hash chain

Each extension inserts a row into `schema_versions`:

| Column | Meaning |
|---|---|
| `version` | Auto-incremented (2, 3, …). |
| `schema` | Full merged schema JSONB at this version. |
| `hash` | `sha256(canonicalJson(schema))`. |
| `prev_hash` | Hash of the previous row, forming a tamper-evident chain. |

Anyone can recompute the hash locally and compare — a tampered historical schema would break the chain.

### Constraints

- Only the collection **creator** can extend.
- Collection must not be archived.
- New field names cannot collide with existing ones.
- Combined field count ≤ 64.
- At least one new field per call.

### NFT birth schemas are immutable

Every NFT records `schema_version` at mint/distribute time. That value never changes. But `set_data` always validates against the **current** schema, which is safe because schemas are append-only: version N is a superset of N-1. An NFT born at v1 can accept v2 fields via `set_data` while its own `schema_version` stays at 1. Client code that wants to render "fields this NFT was born knowing" reads the `schema_versions` row for its version.

## 5. Archiving a collection — `buildArchiveCollection`

`archive_collection` permanently closes a collection. Archived = no new mints, no schema extensions, no data operator grants.

### Preconditions

- Signer is the collection creator.
- Collection is not already archived.
- Collection has **zero live NFTs** (everything burned).

### Effects

1. All NFT approvals and data-operator approvals tied to the collection are deleted.
2. `status` becomes `archived` with the archive block, tx, and timestamp recorded.
3. Irreversible.

The collection row itself stays queryable for historical reference.

```typescript
import { buildArchiveCollection } from "nftlox-sdk";

const result = buildArchiveCollection({
	creator: "ragnarok-studio",
	collectionId: "col_…",
});
```

Posting key. Single signer.

## 6. `totalPotential` and seed shape

`totalPotential` caps the number of **seeds** (unique art templates) a collection can ever contain. Set it to `0` for unlimited.

Seed IDs are deterministic: `sha256(domain | collectionId | artId)`. Duplicate `artId` within the same collection is rejected without needing a global counter.

```
Collection (totalPotential: 3)
├── Seed "fire-sword"      (artId → deterministic seedId)
│   ├── Instance #1
│   └── Instance #2
├── Seed "ice-shield"
│   └── Instance #1
└── Seed "thunder-helm"    ← 3rd seed, cap reached
```

Each seed caps its own instances via its `maxSupply`. Total instances possible in the collection = Σ seed `maxSupply`.

## 7. Ownership provenance

Full cascade: [Ownership Model](ownership.md).

Every NFT row carries `owner`, `previous_owner`, and `owner_operation_id` (the HafAH op that established the current owner). That triple is enough to walk any single ownership step back to L1 without the indexer needing to store an ownership history table.

```typescript
const nft = await client.getNft("nft_…");
// {
//   owner:               "alice",
//   previous_owner:      "bob",
//   owner_operation_id:  "12345678900000001",
//   owner_block_num:     92_345_678,
//   owner_action:        "transfer",
//   created_operation_id: "98765432100000001",   // seed or bulk_distribute that minted this
// }
```

Look up `owner_operation_id` on HafAH for the raw L1 anchor, or pass it to the SPV verifier ([guides/spv.md](../guides/spv.md)) for a client-side ownership-edge check.

## 8. Querying collections

```typescript
const client = createIndexerClient("https://api-nftlox.hivecreators.co");

// List collections (optionally filter by creator)
const cols = await client.getCollections({ creator: "ragnarok-studio", limit: 20 });

// Full collection details
const col = await client.getCollection("col_…");

// NFTs in a collection (filter by type: "seed" | "instance")
const seeds = await client.getCollectionNfts("col_…", { type: "seed", limit: 50 });

// Schema history (full hash chain)
const history = await client.getCollectionSchemaHistory("col_…");
// [{ version, schema, hash, prev_hash }, …]

// Aggregate stats (seed/instance counts, listed, burned, unique owners, floor price)
const stats = await client.getCollectionStats("col_…");
```

## 9. Preview deterministic IDs

Before broadcasting anything, you can preview the IDs that `buildCollection` and `buildSeed` would produce:

```typescript
import { generateCollectionId, generateDeterministicSeedId } from "nftlox-sdk";

const collectionId = await generateCollectionId({
	creator: "ragnarok-studio",
	name: "Heroes of Ragnarok",
	symbol: "HERO",
});
const warriorSeedId = await generateDeterministicSeedId(collectionId, "warrior");
```

Pure functions — no network. Handy for building deep-links or DB fixtures ahead of the on-chain mint.

## See also

- [Data Formats — `create_collection`, `extend_schema`, `archive_collection`](../data-formats.md#create_collection)
- [SDK Reference — collection builders](../sdk/reference.md#collections)
- [Seed Ceremony](../use-cases/seed-ceremony.md) for the full launch script.
- [Ownership Model](ownership.md) for the creator/owner distinction and provenance fields.

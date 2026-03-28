# Game Integration Guide

**Audience:** Game developers integrating NFTLox as the on-chain layer for in-game NFTs.

**Primary use case:** A card game (e.g., 2,134 unique cards) where each card is an on-chain NFT with immutable stats and mutable game progression.

**Recommended pattern:** Server-Side Resolution -- your game server resolves which cards to award using NFTLox's deterministic RNG, then distributes real NFTs on-chain via `bulk_distribute`.

For the RNG algorithm specification, see [RNG Reference](rng-reference.md). For runnable code examples, see the [Examples](examples/) directory.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Why This Pattern](#2-why-this-pattern)
3. [Step-by-Step Flow](#3-step-by-step-flow)
4. [Verification](#4-verification)
5. [Data Operators for Game Servers](#5-data-operators-for-game-servers)
6. [Protocol Limits Reference](#6-protocol-limits-reference)

---

## 1. Architecture Overview

```
Game Server                           Hive Blockchain
-----------                           ---------------

[Card Database]                       [NFTLox Protocol]
  2,134 cards                           create_collection
      |                                 mint (seeds)
      v                                 bulk_distribute (instances)
[1. Create Collection] --POST-------> /api/build/collection
      |
[2. Mint Seeds]        --POST-------> /api/build/seeds
      |                                 Seeds on-chain (with immutableData)
      v
[3. Player buys pack]
      |
  a. Player sends HIVE payment
  b. Server reads payment txId + blockNum from chain
  c. Server runs resolveDropTable() locally with full card catalog
  d. Server calls bulk_distribute with resolved seed IDs
      |                --POST-------> /api/build/bulk-distribute
      v                                 Instances on-chain
[4. Player receives cards]              (inherit seed immutableData)
      |
[5. Update game data]  --POST-------> /api/build/set-data
                                        or /api/build/set-data-from
```

The playground API is a payload builder. It does not broadcast transactions directly -- your server signs the resulting Hive `custom_json` operations and broadcasts them to the network.

---

## 2. Why This Pattern

The built-in NFTLox pack system (`pack_create`) limits drop tables to **50 entries** (`MAX_DROP_TABLE_ENTRIES`). A game with 2,134 unique cards cannot fit its entire catalog into a single on-chain pack definition.

Server-Side Resolution removes this constraint entirely by moving the card selection logic to your server while keeping the randomness fully verifiable:

- **No drop table size limit.** Your server runs the RNG locally against the full card catalog -- thousands of entries, no problem. Only the *result* is recorded on-chain via `bulk_distribute`.
- **Trustless randomness.** The RNG seed is derived from immutable blockchain data (transaction ID, block number, player account). Anyone can re-derive the same results independently.
- **Real card data on-chain.** Instances created by `bulk_distribute` inherit the seed's `immutableData` automatically -- card stats, rarity, type, and any other immutable fields live on-chain from the moment of creation.
- **Full verifiability.** Given the same drop table and the same RNG seed, `resolveDropTable()` always produces identical output. See the [RNG Reference](rng-reference.md) for the complete algorithm specification.

---

## 3. Step-by-Step Flow

### Step 1: Create a Collection

Define your game's collection with a typed schema via the playground API. The schema declares which fields are immutable (set once at mint) and which are mutable (updated during gameplay).

**Endpoint:** `POST /api/build/collection`

```json
{
	"creator": "ragnarok-game",
	"name": "Ragnarok Card Game",
	"symbol": "RAGNAROK",
	"totalPotential": 500000,
	"metadata": {
		"description": "Norse mythology card game on Hive",
		"image": "https://ragnarok.game/banner.png"
	},
	"rules": {
		"transferable": true,
		"burnable": true,
		"replicable": false,
		"royaltyPct": 5,
		"royaltyRecipient": "ragnarok-game"
	},
	"schema": {
		"immutable": [
			{ "name": "card_id", "type": "uint32" },
			{ "name": "card_type", "type": "string" },
			{ "name": "mana_cost", "type": "uint8" },
			{ "name": "rarity", "type": "string" },
			{ "name": "hero_class", "type": "string" },
			{ "name": "base_attack", "type": "uint16" },
			{ "name": "base_health", "type": "uint16" },
			{ "name": "keywords", "type": "string[]" },
			{ "name": "edition", "type": "string" }
		],
		"mutable": [
			{ "name": "level", "type": "uint8" },
			{ "name": "xp", "type": "uint32" },
			{ "name": "wins", "type": "uint32" },
			{ "name": "losses", "type": "uint32" }
		]
	}
}
```

**Response (success):**

```json
{
	"success": true,
	"protocolVersion": "0.3.0",
	"hashVersion": "v1",
	"collectionId": "col_abc123def456",
	"generatedIds": { "collectionId": "col_abc123def456", "originDna": "A1B2C3D4E5F6G7H8" },
	"operation": ["custom_json", { "..." }],
	"payload": { "..." }
}
```

Save the `collectionId` and `originDna` from the response -- you will need them for minting seeds.

The `operation` field contains a ready-to-sign Hive `custom_json` operation. Sign it with the creator's posting key and broadcast to a Hive RPC node.

### Step 2: Mint Seeds

Each unique card in your catalog becomes one **seed** -- a non-transferable template NFT. When players open packs later, the protocol creates **instances** of those seeds. Instances automatically inherit the seed's `immutableData`, so your card stats are baked into the NFT from birth.

**Endpoint:** `POST /api/build/seeds`

```json
{
	"collectionId": "col_abc123def456",
	"owner": "ragnarok-game",
	"seeds": [
		{
			"artId": "odin-allfather",
			"name": "Odin, Allfather",
			"imageUrl": "https://ragnarok.game/cards/odin-allfather.png",
			"maxSupply": 1000
		},
		{
			"artId": "frost-giant",
			"name": "Frost Giant",
			"imageUrl": "https://ragnarok.game/cards/frost-giant.png",
			"maxSupply": 10000
		}
	]
}
```

**Response (success):**

```json
{
	"success": true,
	"protocolVersion": "0.3.0",
	"collectionId": "col_abc123def456",
	"generatedIds": {
		"odin-allfather": "seed_a1b2c3d4",
		"frost-giant": "seed_e5f6g7h8"
	},
	"seeds": [
		{ "artId": "odin-allfather", "seedId": "seed_a1b2c3d4", "operation": ["custom_json", { "..." }] },
		{ "artId": "frost-giant", "seedId": "seed_e5f6g7h8", "operation": ["custom_json", { "..." }] }
	],
	"batches": [
		{ "batchNumber": 1, "operationCount": 2, "operations": ["..."] }
	]
}
```

Hive allows a maximum of **5 `custom_json` operations per transaction** (`MAX_OPERATIONS_PER_TX`). The API automatically groups seeds into batches that respect this limit. Sign and broadcast each batch as a separate Hive transaction, waiting at least 4 seconds (`TX_DELAY_MS`) between batches for block confirmation.

For a catalog of 2,134 cards, this works out to roughly 427 transactions over about 28 minutes. This is a one-time setup cost that you only need to perform when adding new cards.

**Seed IDs are deterministic:** the same `collectionId + artId` combination always produces the same `seedId`. You can pre-compute all seed IDs without minting by calling the `/api/build/preview-ids` endpoint.

For a complete minting script, see [Seed Ceremony Example](examples/seed-ceremony.md).

### Step 3: Pack Opening via Server-Side Resolution

This is where the pattern comes together. Instead of using the built-in NFTLox pack system (which has a 50-entry drop table limit), your game server handles the card selection locally and then records the result on-chain:

1. **Accept the player's HIVE payment** (a standard Hive transfer operation).
2. **Read the payment's `txId` and `blockNum`** from the blockchain (via `get_transaction` or by streaming blocks).
3. **Run `resolveDropTable()` locally** using the full card catalog as the drop table.
4. **Call `/api/build/bulk-distribute`** with the resolved seed IDs to mint real NFT instances for the player.

**Building the drop table:**

Map each card to a weight. Higher weight means higher probability of being selected. There is no size limit on the local drop table -- use as many entries as your game needs.

```typescript
const RARITY_WEIGHTS: Record<string, number> = {
	legendary: 1,
	epic: 5,
	rare: 20,
	common: 100,
};

const dropTable = cards.map((card) => ({
	seedId: seedIdMap[card.artId],
	weight: RARITY_WEIGHTS[card.rarity] ?? 100,
}));
```

**Constructing the RNG seed:**

```
rngSeed = "${paymentTxId}:${paymentBlockNum}:${playerUsername}"
```

The seed is derived entirely from immutable blockchain data, making it publicly verifiable by anyone.

**Resolving the drop table:**

```typescript
import { resolveDropTable } from "nftlox-sdk";

const resolvedSeedIds = resolveDropTable(dropTable, 5, rngSeed);
// Returns 5 seed IDs selected by weighted random
```

See [RNG Reference](rng-reference.md) for the full algorithm specification.

**Endpoint:** `POST /api/build/bulk-distribute`

```json
{
	"signer": "ragnarok-game",
	"to": "player-alice",
	"items": [
		{ "seedId": "seed_a1b2c3d4", "quantity": 2, "originBlock": 92345678 },
		{ "seedId": "seed_e5f6g7h8", "quantity": 1, "originBlock": 92345678 },
		{ "seedId": "seed_i9j0k1l2", "quantity": 2, "originBlock": 92345678 }
	]
}
```

Aggregate resolved seeds before sending: if `resolveDropTable()` returns the same seed ID more than once, combine them into a single entry with the appropriate `quantity` rather than sending duplicate entries. The `originBlock` should be the block number of the player's payment transaction.

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.3.0",
	"operation": ["custom_json", { "..." }],
	"payload": { "..." },
	"keyType": "Posting"
}
```

Sign the resulting operation with the collection creator's posting key and broadcast it to the network.

**What happens on-chain:** The NFTLox indexer processes `bulk_distribute` and for each item:
1. Looks up the seed and validates that it has available supply.
2. Generates deterministic instance IDs, DNA, and access keys.
3. Copies the seed's `immutableData` to every new instance automatically.

The player now owns NFT instances with real card data living on-chain.

For the complete pack opening flow with payment detection and verification, see [Pack Opening Example](examples/pack-opening.md).

### Step 4: Update Game Data

After matches or gameplay events, update mutable fields (level, XP, wins, losses) using `set_data` or `set_data_from`.

Use `set_data` when the collection creator is updating the data directly. Use `set_data_from` when a separate game server account (a data operator) needs to make updates on behalf of the creator. See [Section 5](#5-data-operators-for-game-servers) for how to set up data operators.

**Endpoint (as creator):** `POST /api/build/set-data`

```json
{
	"issuer": "ragnarok-game",
	"nftId": "nft_a1b2c3d4_1_ef56",
	"instanceDna": "A1B2C3D4E5F6G7",
	"mutableData": {
		"level": 5,
		"xp": 2450,
		"wins": 12,
		"losses": 3
	}
}
```

**Endpoint (as data operator):** `POST /api/build/set-data-from`

```json
{
	"operator": "ragnarok-server",
	"nftId": "nft_a1b2c3d4_1_ef56",
	"instanceDna": "A1B2C3D4E5F6G7",
	"mutableData": {
		"level": 5,
		"xp": 2450,
		"wins": 12,
		"losses": 3
	}
}
```

For details on mutable data operations, see [Mutable Data Example](examples/mutable-data.md).

---

## 4. Verification

One of the key advantages of Server-Side Resolution is that anyone can independently verify that a pack opening was fair. Given the publicly available blockchain data (payment txId, block number, player account) and the published drop table, anyone can reproduce the exact same card selection:

```typescript
import { resolveDropTable } from "nftlox-sdk";

function verifyPackOpen(
	paymentTxId: string,
	blockNum: number,
	player: string,
	expectedSeedIds: string[],
	dropTable: Array<{ seedId: string; weight: number }>,
	cardsPerPack: number,
): boolean {
	const rngSeed = `${paymentTxId}:${blockNum}:${player}`;
	const resolved = resolveDropTable(dropTable, cardsPerPack, rngSeed);
	return resolved.every((id, i) => id === expectedSeedIds[i]);
}
```

**Requirements for verification:**
1. The **drop table** must be published (card catalog with rarity weights). You can store it in the collection metadata, host it at a public URL, or embed it in the game client.
2. The **payment transaction** must be on-chain (this provides the txId and blockNum for the RNG seed).
3. The **RNG algorithm** must be the same version. See [RNG Reference](rng-reference.md) for a language-independent specification with pseudocode and test vectors.

The SDK also ships an SPV (Simplified Payment Verification) module for auditing pack opens: `replayDropTableResolution`, `verifyDeterministicDerivation`, `verifyOperationOnChain`, and `runAudit`.

---

## 5. Data Operators for Game Servers

If the Hive account running your game server is different from the collection creator account, you will need to authorize it as a **data operator**. This allows the game server to update mutable data on NFTs without needing the creator's private key.

### Granting operator access

The collection creator broadcasts this authorization once:

**Endpoint:** `POST /api/build/data-operator-approve`

```json
{
	"creator": "ragnarok-game",
	"collectionId": "col_abc123def456",
	"operator": "ragnarok-server",
	"approved": true
}
```

### Updating data as an operator

Once authorized, the game server uses `set_data_from` instead of `set_data`:

**Endpoint:** `POST /api/build/set-data-from`

```json
{
	"operator": "ragnarok-server",
	"nftId": "nft_a1b2c3d4_1_ef56",
	"instanceDna": "A1B2C3D4E5F6G7",
	"mutableData": {
		"level": 10,
		"xp": 8500,
		"wins": 42,
		"losses": 11
	}
}
```

You can batch up to 5 `set_data_from` operations per Hive transaction.

### Revoking access

To revoke an operator's access, set `approved` to `false`:

```json
{
	"creator": "ragnarok-game",
	"collectionId": "col_abc123def456",
	"operator": "ragnarok-server",
	"approved": false
}
```

---

## 6. Protocol Limits Reference

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_OPERATIONS_PER_TX` | 5 | Hive `custom_json` operations per transaction |
| `MAX_BULK_DISTRIBUTE_ITEMS` | 50 | Distinct seed IDs per `bulk_distribute` operation |
| `MAX_DROP_TABLE_ENTRIES` | 50 | Drop table entries per `pack_create` (does NOT apply to Server-Side Resolution) |
| `TX_DELAY_MS` | 4000 | Recommended delay between transactions (ms) |
| `SAFE_PAYLOAD_MAX_BYTES` | 7372 | Max payload size per `custom_json` (~90% of 8KB) |
| `MAX_ITEMS_PER_PACK` | 20 | Items per pack (built-in pack system only) |
| `MAX_NAME_LENGTH` | 100 | Collection/NFT name length |
| `MAX_DESCRIPTION_LENGTH` | 250 | Description field length |
| `MAX_SCHEMA_FIELDS` | 64 | Fields per schema section (immutable or mutable) |

**Note:** `MAX_BULK_DISTRIBUTE_ITEMS = 50` limits the number of *distinct* seed IDs per operation, not the total number of instances. Each entry can have `quantity > 1`. For example, 3 distinct seeds with quantities [20, 15, 15] produces 50 instances in a single operation. If a pack opening resolves to more than 50 distinct seeds (unlikely for typical 5-card packs), split the request into multiple `bulk_distribute` operations.

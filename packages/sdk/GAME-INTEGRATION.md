# NFTLox Game Integration Guide

**Audience:** Game developers integrating NFTLox as a "birth layer" for in-game NFTs.

**Primary use case:** A card game (e.g., Ragnarok with 2,134 unique cards) where each card is an on-chain NFT with immutable stats and mutable game progression.

**Recommended pattern:** Option C+ -- NFTLox deterministic RNG + `bulk_distribute`. This avoids the pack system's 50-entry drop table limit, keeps real card data on-chain, and provides fully verifiable randomness.

For general protocol operations, see [OPERATIONS.md](./OPERATIONS.md). For SDK setup and overview, see [README.md](./README.md).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Step 1: Collection Setup](#2-step-1-collection-setup)
3. [Step 2: Seed Minting](#3-step-2-seed-minting)
4. [Step 3: Pack Opening via bulk_distribute](#4-step-3-pack-opening-via-bulk_distribute)
5. [Step 4: Verification](#5-step-4-verification)
6. [Step 5: Mutable Data Updates](#6-step-5-mutable-data-updates)
7. [Step 6: Data Operators](#7-step-6-data-operators)
8. [RNG Algorithm Reference](#8-rng-algorithm-reference)
9. [Protocol Limits Reference](#9-protocol-limits-reference)
10. [Complete End-to-End Example](#10-complete-end-to-end-example)

---

## 1. Architecture Overview

```
Game Server                         Hive Blockchain
-----------                         ---------------

[Card Database]                     [NFTLox Protocol]
  2,134 cards                         create_collection
      |                               mint (seeds)
      v                               bulk_distribute (instances)
[Collection + Schema]                 set_data / set_data_from
      |
      v
[Mint 2,134 Seeds] ----broadcast----> Seeds on-chain (with immutableData)
      |
      v
[Player buys pack]
      |
  1. Player sends HIVE payment
  2. Server reads payment txId + blockNum from chain
  3. Server runs resolveDropTable() locally with full card catalog
  4. Server calls bulk_distribute with resolved seed IDs
      |                               Instances on-chain
      v                               (inherit seed's immutableData)
[Player receives cards]
```

**Why not use NFTLox packs directly?** The `pack_create` action limits drop tables to 50 entries (`MAX_DROP_TABLE_ENTRIES`). A game with 2,134 cards cannot fit all entries into a single pack. Option C+ removes this constraint by running the RNG locally against the full catalog, then using `bulk_distribute` to mint the resolved cards.

**What you get:**
- Trustless RNG seeded from immutable blockchain data (transaction ID, block number)
- Real card stats on-chain (instances inherit the seed's `immutableData`)
- No drop table size limit (the 50-entry cap only applies to `pack_create` payloads)
- Full verifiability -- anyone can re-derive the exact same results

---

## 2. Step 1: Collection Setup

Create a collection with a typed schema. The schema defines which fields are immutable (set at mint, never change) and which are mutable (updated during gameplay).

```typescript
import {
	createDeterministicCollectionPayload,
	createSchemaBuilder,
	type DeterministicCollectionInput,
	type CollectionSchema,
} from "nftlox-sdk";

// Define the schema for your card game
const cardSchema: CollectionSchema = createSchemaBuilder()
	// Immutable: set when seed is minted, inherited by all instances
	.immutable("card_id", "uint32")
	.immutable("card_type", "string")     // "minion" | "spell" | "weapon" | "hero"
	.immutable("mana_cost", "uint8")
	.immutable("rarity", "string")        // "common" | "rare" | "epic" | "legendary"
	.immutable("hero_class", "string")
	.immutable("base_attack", "uint16")
	.immutable("base_health", "uint16")
	.immutable("keywords", "string[]")
	.immutable("edition", "string")       // "core" | "expansion-1"
	// Mutable: updated by game server during gameplay
	.mutable("level", "uint8")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.mutable("losses", "uint32")
	.build();

const collectionInput: DeterministicCollectionInput = {
	name: "Ragnarok Card Game",
	symbol: "RAGNAROK",
	creator: "ragnarok-game",
	totalPotential: 500000,  // max instances across all seeds
	metadata: {
		description: "Norse mythology card game on Hive",
		image: "https://ragnarok.game/collection-banner.png",
	},
	rules: {
		transferable: true,
		burnable: true,
		replicable: false,
		royaltyPct: 5,
		royaltyRecipient: "ragnarok-game",
	},
	schema: cardSchema,
};

const collectionPayload = createDeterministicCollectionPayload(collectionInput);
// collectionPayload.data.id is deterministic: same creator + name + symbol = same ID
```

The SDK also exports pre-built templates for Ragnarok-style card types: `RAGNAROK_MINION_SCHEMA`, `RAGNAROK_SPELL_SCHEMA`, `RAGNAROK_WEAPON_SCHEMA`, `RAGNAROK_PET_SCHEMA`, `RAGNAROK_ARMOR_SCHEMA`, `RAGNAROK_HERO_SCHEMA`.

---

## 3. Step 2: Seed Minting

A **seed** is a non-transferable template NFT. Each unique card in your game becomes one seed. When a player "opens a pack," the protocol creates **instances** of those seeds. Instances inherit the seed's `immutableData` automatically.

### Defining Your Card Catalog

```typescript
import {
	createDeterministicMintPayload,
	generateDeterministicSeedId,
	type DeterministicMintInput,
} from "nftlox-sdk";

// Your full card database (loaded from JSON, DB, etc.)
interface CardDefinition {
	readonly artId: string;       // unique within collection, max 14 chars
	readonly name: string;
	readonly imageUrl: string;
	readonly maxSupply: number;
	readonly cardType: string;
	readonly manaCost: number;
	readonly rarity: string;
	readonly heroClass: string;
	readonly baseAttack: number;
	readonly baseHealth: number;
	readonly keywords: string[];
	readonly edition: string;
}

const CARD_CATALOG: ReadonlyArray<CardDefinition> = [
	{
		artId: "odin-allfather",
		name: "Odin, Allfather",
		imageUrl: "https://ragnarok.game/cards/odin-allfather.png",
		maxSupply: 1000,
		cardType: "hero",
		manaCost: 8,
		rarity: "legendary",
		heroClass: "asgardian",
		baseAttack: 6,
		baseHealth: 10,
		keywords: ["divine", "wisdom"],
		edition: "core",
	},
	{
		artId: "frost-giant",
		name: "Frost Giant",
		imageUrl: "https://ragnarok.game/cards/frost-giant.png",
		maxSupply: 10000,
		cardType: "minion",
		manaCost: 5,
		rarity: "common",
		heroClass: "neutral",
		baseAttack: 4,
		baseHealth: 6,
		keywords: ["jotun"],
		edition: "core",
	},
	// ... 2,132 more cards
];
```

### Minting Seeds in Batches

Hive allows `MAX_OPERATIONS_PER_TX = 5` custom_json operations per transaction. Each seed is one mint operation, so you mint 5 seeds per transaction.

```typescript
import { MAX_OPERATIONS_PER_TX, TX_DELAY_MS } from "nftlox-sdk";

const COLLECTION_ID = "col_abc123def4";  // from step 1
const COLLECTION_ORIGIN_DNA = "A1B2C3D4E5F6G7H8"; // from step 1
const CREATOR = "ragnarok-game";

function buildSeedMintPayload(card: CardDefinition): DeterministicMintInput {
	return {
		artId: card.artId,
		collectionId: COLLECTION_ID,
		collectionOriginDna: COLLECTION_ORIGIN_DNA,
		edition: 1,
		owner: CREATOR,
		name: card.name,
		imageUrl: card.imageUrl,
		maxReplicas: card.maxSupply,
		immutableData: {
			card_id: CARD_CATALOG.indexOf(card) + 1,
			card_type: card.cardType,
			mana_cost: card.manaCost,
			rarity: card.rarity,
			hero_class: card.heroClass,
			base_attack: card.baseAttack,
			base_health: card.baseHealth,
			keywords: card.keywords,
			edition: card.edition,
		},
	};
}

// Batch seeds into groups of 5 for Hive transactions
function chunkArray<T>(arr: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}

async function mintAllSeeds(
	cards: ReadonlyArray<CardDefinition>,
	broadcastFn: (operations: ReadonlyArray<unknown>) => Promise<string>,
): Promise<void> {
	const batches = chunkArray(cards, MAX_OPERATIONS_PER_TX);

	for (const batch of batches) {
		const operations = batch.map((card) => {
			const payload = createDeterministicMintPayload(buildSeedMintPayload(card));
			return [
				"custom_json",
				{
					required_auths: [],
					required_posting_auths: [CREATOR],
					id: "nftlox_testnet",
					json: JSON.stringify(payload),
				},
			];
		});

		await broadcastFn(operations);
		// Wait for block confirmation between batches
		await new Promise((resolve) => setTimeout(resolve, TX_DELAY_MS));
	}
}
```

For 2,134 cards at 5 per transaction, this requires 427 transactions. At ~3 seconds per block, the full seed minting takes roughly 21 minutes. This is a one-time setup cost.

### Seed ID Determinism

The `seedId` is derived deterministically from `collectionId + artId`:

```typescript
const seedId = generateDeterministicSeedId(COLLECTION_ID, "odin-allfather");
// Always produces the same seedId for the same inputs
```

This means you can pre-compute all seed IDs before minting, and verify them afterward.

---

## 4. Step 3: Pack Opening via bulk_distribute

This is the core pattern. Instead of using the NFTLox pack system, you:

1. Accept the player's HIVE payment
2. Read the payment's `txId` and `blockNum` from the blockchain
3. Run `resolveDropTable()` locally with the full card catalog as the drop table
4. Call `bulk_distribute` with the resolved seed IDs

### Building the Drop Table

The drop table maps each seed to a weight. Higher weight means higher probability of being selected. The drop table used locally has **no size limit** (the 50-entry cap only applies to `pack_create` payloads on-chain).

```typescript
import {
	resolveDropTable,
	deterministicRng,
	generateDeterministicSeedId,
	createBulkDistributePayload,
	MAX_BULK_DISTRIBUTE_ITEMS,
} from "nftlox-sdk";

// Build drop table from full card catalog
// Weight mapping: legendary=1, epic=5, rare=20, common=100
const RARITY_WEIGHTS: Readonly<Record<string, number>> = {
	legendary: 1,
	epic: 5,
	rare: 20,
	common: 100,
} as const;

function buildFullDropTable(
	cards: ReadonlyArray<CardDefinition>,
	collectionId: string,
): ReadonlyArray<{ seedId: string; weight: number }> {
	return cards.map((card) => ({
		seedId: generateDeterministicSeedId(collectionId, card.artId),
		weight: RARITY_WEIGHTS[card.rarity] ?? 100,
	}));
}

const fullDropTable = buildFullDropTable(CARD_CATALOG, COLLECTION_ID);
// fullDropTable.length === 2134 -- no problem, no on-chain limit
```

### Constructing the RNG Seed

The RNG seed must be derived from **immutable blockchain data** so anyone can verify the result. Use the player's payment transaction ID, block number, and username.

```typescript
// After the player's HIVE payment is confirmed on-chain:
function buildPackOpenRngSeed(
	paymentTxId: string,
	blockNum: number,
	player: string,
): string {
	return `${paymentTxId}:${blockNum}:${player}`;
}

// Example:
const rngSeed = buildPackOpenRngSeed(
	"abc123def456789012345678901234567890abcd",
	92_345_678,
	"player-alice",
);
// "abc123def456789012345678901234567890abcd:92345678:player-alice"
```

### Resolving the Drop Table

`resolveDropTable()` performs weighted random selection using the deterministic RNG. Same inputs always produce the same outputs.

```typescript
const CARDS_PER_PACK = 5;

const resolvedSeedIds = resolveDropTable(
	fullDropTable as Array<{ seedId: string; weight: number }>,
	CARDS_PER_PACK,
	rngSeed,
);
// resolvedSeedIds: ["seed_a1b2c3d4", "seed_e5f6g7h8", ...]
// Exactly 5 seed IDs, selected by weighted random
```

### Aggregating and Broadcasting

`bulk_distribute` expects aggregated items (unique seed IDs with quantities). It supports up to `MAX_BULK_DISTRIBUTE_ITEMS = 50` distinct seeds per operation.

```typescript
function aggregateSeedIds(
	seedIds: ReadonlyArray<string>,
	originBlock: number,
): ReadonlyArray<{ seedId: string; quantity: number; originBlock: number }> {
	const counts = new Map<string, number>();
	for (const id of seedIds) {
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return Array.from(counts.entries()).map(([seedId, quantity]) => ({
		seedId,
		quantity,
		originBlock,
	}));
}

async function openPack(
	player: string,
	paymentTxId: string,
	paymentBlockNum: number,
	broadcastFn: (operations: ReadonlyArray<unknown>) => Promise<string>,
): Promise<ReadonlyArray<string>> {
	const rngSeed = buildPackOpenRngSeed(paymentTxId, paymentBlockNum, player);
	const resolvedSeedIds = resolveDropTable(
		fullDropTable as Array<{ seedId: string; weight: number }>,
		CARDS_PER_PACK,
		rngSeed,
	);

	const aggregated = aggregateSeedIds(resolvedSeedIds, paymentBlockNum);

	const payload = createBulkDistributePayload({
		to: player,
		items: aggregated as Array<{ seedId: string; quantity: number; originBlock: number }>,
	});

	const operation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: ["ragnarok-game"],
			id: "nftlox_testnet",
			json: JSON.stringify(payload),
		},
	];

	await broadcastFn([operation]);
	return resolvedSeedIds;
}
```

### What Happens On-Chain

When the indexer processes `bulk_distribute`, for each item it:

1. Looks up the seed and validates it exists, is not burned/lent, and has available supply
2. Generates deterministic instance IDs: `generateDeterministicInstanceId(seedId, instanceNumber)`
3. Generates deterministic DNA: `generateDeterministicInstanceDna(seedId, instanceNumber, txId, blockNum)`
4. Generates deterministic access keys: `generateDeterministicAccessKey(instanceDna, signer, txId)`
5. **Copies the seed's `immutableData` to every instance** -- the card stats live on-chain

The player now owns NFT instances with real card data baked in.

---

## 5. Step 4: Verification

Anyone can independently verify that a pack opening was fair.

### Re-Running the RNG

Given the public blockchain data (payment txId, block number, player name), anyone can reproduce the exact same card selection:

```typescript
import { resolveDropTable } from "nftlox-sdk";

function verifyPackOpen(
	paymentTxId: string,
	blockNum: number,
	player: string,
	expectedSeedIds: ReadonlyArray<string>,
	dropTable: ReadonlyArray<{ seedId: string; weight: number }>,
	cardsPerPack: number,
): boolean {
	const rngSeed = `${paymentTxId}:${blockNum}:${player}`;
	const resolved = resolveDropTable(
		dropTable as Array<{ seedId: string; weight: number }>,
		cardsPerPack,
		rngSeed,
	);

	if (resolved.length !== expectedSeedIds.length) return false;
	return resolved.every((id, i) => id === expectedSeedIds[i]);
}
```

### Verifying Instance Derivation

Once you know which seed IDs were selected, you can also verify that the correct instance IDs, DNA, and access keys were derived:

```typescript
import {
	generateDeterministicInstanceId,
	generateDeterministicInstanceDna,
	generateDeterministicAccessKey,
} from "nftlox-sdk";

function verifyInstance(
	seedId: string,
	instanceNumber: number,
	txId: string,
	blockNum: number,
	signer: string,
	expected: { instanceId: string; instanceDna: string; accessKey: string },
): boolean {
	const derivedId = generateDeterministicInstanceId(seedId, instanceNumber);
	const derivedDna = generateDeterministicInstanceDna(seedId, instanceNumber, txId, blockNum);
	const derivedKey = generateDeterministicAccessKey(derivedDna, signer, txId);

	return (
		derivedId === expected.instanceId &&
		derivedDna === expected.instanceDna &&
		derivedKey === expected.accessKey
	);
}
```

### SPV Module

The SDK ships a full SPV (Simplified Payment Verification) module for auditing pack opens and on-chain operations. See `nftlox-sdk` exports: `replayDropTableResolution`, `verifyDeterministicDerivation`, `verifyOperationOnChain`, `runAudit`.

---

## 6. Step 5: Mutable Data Updates

Cards have mutable fields (level, xp, wins, losses) that change during gameplay. The collection **must have a schema** for mutable data updates to be accepted.

### Creator Updates with set_data

If the game server IS the collection creator:

```typescript
import { createSetDataOperation, type SetDataInput } from "nftlox-sdk";

const updateInput: SetDataInput = {
	nftId: "nft_a1b2c3d4_1_ef56",
	instanceDna: "A1B2C3D4E5F6G7",
	mutableData: {
		level: 5,
		xp: 2450,
		wins: 12,
		losses: 3,
	},
};

const operation = createSetDataOperation(updateInput, "ragnarok-game");
// Broadcast this operation to Hive
```

### Batch Updates

You can batch up to `MAX_OPERATIONS_PER_TX = 5` set_data operations per Hive transaction:

```typescript
const updates: ReadonlyArray<SetDataInput> = [
	{ nftId: "nft_a1_1_ef56", instanceDna: "DNA1...", mutableData: { level: 5, xp: 2450 } },
	{ nftId: "nft_b2_1_gh78", instanceDna: "DNA2...", mutableData: { level: 3, xp: 980 } },
	{ nftId: "nft_c3_1_ij90", instanceDna: "DNA3...", mutableData: { wins: 15, losses: 7 } },
	// up to 5 per transaction
];

const operations = updates.map((input) =>
	createSetDataOperation(input, "ragnarok-game"),
);
// Broadcast all operations in a single Hive transaction
```

---

## 7. Step 6: Data Operators

If your game server account is different from the collection creator, you need to authorize it as a **data operator**. This lets the game server update mutable data on behalf of the creator.

### Granting Operator Access

The collection creator broadcasts this once:

```typescript
import {
	createDataOperatorApproveOperation,
	type DataOperatorApproveInput,
} from "nftlox-sdk";

const approveInput: DataOperatorApproveInput = {
	collectionId: "col_abc123def4",
	operator: "ragnarok-server",  // the game server's Hive account
	approved: true,
};

const operation = createDataOperatorApproveOperation(approveInput, "ragnarok-game");
// Broadcast as collection creator
```

### Updating Data as Operator

The game server then uses `set_data_from` instead of `set_data`:

```typescript
import {
	createSetDataFromOperation,
	type SetDataFromInput,
} from "nftlox-sdk";

const updateInput: SetDataFromInput = {
	nftId: "nft_a1b2c3d4_1_ef56",
	instanceDna: "A1B2C3D4E5F6G7",
	mutableData: {
		level: 10,
		xp: 8500,
		wins: 42,
		losses: 11,
	},
};

const operation = createSetDataFromOperation(updateInput, "ragnarok-server");
// Broadcast as the data operator (game server)
```

### Revoking Access

To revoke operator access, set `approved: false`:

```typescript
const revokeInput: DataOperatorApproveInput = {
	collectionId: "col_abc123def4",
	operator: "ragnarok-server",
	approved: false,
};

const operation = createDataOperatorApproveOperation(revokeInput, "ragnarok-game");
```

---

## 8. RNG Algorithm Reference

The deterministic RNG is the core of trustless pack openings. This section documents the algorithm so it can be independently implemented in any language.

### deterministicRng(seed, index)

Returns a deterministic float in `[0, 1)` for a given seed string and index number.

**Algorithm:** Dual-pass FNV-1a 32-bit hash.

```
Input string: "nftlox:rng:{seed}:{index}"

Pass 1 (forward):
  hash1 = 2166136261  (FNV offset basis)
  for each byte in input (left to right):
    hash1 = hash1 XOR byte
    hash1 = hash1 * 16777619  (FNV prime, using wrapping multiply)

Pass 2 (reverse):
  hash2 = 2166136261
  for each byte in input (right to left):
    hash2 = hash2 XOR byte
    hash2 = hash2 * 16777619

Combine:
  combined = (abs(hash1) XOR abs(hash2)) as unsigned 32-bit integer

Result:
  combined / 4294967296  (divide by 2^32)
```

In TypeScript:

```typescript
function deterministicRng(seed: string, index: number): number {
	const input = `nftlox:rng:${seed}:${index}`;

	let hash1 = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash1 ^= input.charCodeAt(i);
		hash1 = Math.imul(hash1, 16777619);
	}

	let hash2 = 2166136261;
	for (let i = input.length - 1; i >= 0; i--) {
		hash2 ^= input.charCodeAt(i);
		hash2 = Math.imul(hash2, 16777619);
	}

	const combined = (Math.abs(hash1) ^ Math.abs(hash2)) >>> 0;
	return combined / 4294967296;
}
```

### resolveDropTable(dropTable, itemCount, rngSeed)

Selects `itemCount` items from a weighted drop table using `deterministicRng`.

**Algorithm:**

```
totalWeight = sum of all entry weights

for i in 0..itemCount:
  roll = deterministicRng(rngSeed, i) * totalWeight
  cumulative = 0
  for each entry in dropTable:
    cumulative += entry.weight
    if roll < cumulative:
      select entry.seedId
      break
```

Each selection is independent (sampling with replacement). The same seed can be selected multiple times.

---

## 9. Protocol Limits Reference

| Constant                      | Value | Description                                         |
|-------------------------------|-------|-----------------------------------------------------|
| `MAX_OPERATIONS_PER_TX`       | 5     | Hive custom_json operations per transaction          |
| `MAX_BULK_DISTRIBUTE_ITEMS`   | 50    | Distinct seed IDs per `bulk_distribute` operation    |
| `MAX_DROP_TABLE_ENTRIES`      | 50    | Drop table entries per `pack_create` (NOT local RNG) |
| `TX_DELAY_MS`                 | 4000  | Recommended delay between transactions (ms)          |
| `SAFE_PAYLOAD_MAX_BYTES`      | 7372  | Max payload size per custom_json (~90% of 8KB)       |
| `MAX_ITEMS_PER_PACK`          | 20    | Items per pack (pack system only)                    |
| `MAX_NAME_LENGTH`             | 100   | Collection/NFT name length                           |
| `MAX_DESCRIPTION_LENGTH`      | 250   | Description field length                             |
| `MAX_SCHEMA_FIELDS`           | 64    | Fields per schema section (immutable or mutable)     |

**Important:** `MAX_BULK_DISTRIBUTE_ITEMS = 50` limits distinct seed IDs per operation, but each entry can have `quantity > 1`. For example, 3 distinct seeds with quantities [20, 15, 15] = 50 instances in one operation. If a pack opening resolves to more than 50 distinct seeds (unlikely for 5-card packs, possible for bulk operations), split into multiple `bulk_distribute` operations.

---

## 10. Complete End-to-End Example

This example ties together all steps: collection creation, seed minting, pack opening, and verification.

```typescript
import {
	// Payload creation
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	createBulkDistributePayload,
	createSetDataFromOperation,
	createDataOperatorApproveOperation,
	// DNA & RNG
	generateDeterministicSeedId,
	generateOriginDna,
	resolveDropTable,
	// Schema
	createSchemaBuilder,
	// Constants
	MAX_OPERATIONS_PER_TX,
	TX_DELAY_MS,
	// Types
	type DeterministicCollectionInput,
	type DeterministicMintInput,
	type CollectionSchema,
	type DataOperatorApproveInput,
	type SetDataFromInput,
} from "nftlox-sdk";

// ---------------------------------------------------------------
// STEP 1: Define schema and create collection
// ---------------------------------------------------------------

const CREATOR = "ragnarok-game";
const GAME_SERVER = "ragnarok-server";

const schema: CollectionSchema = createSchemaBuilder()
	.immutable("card_id", "uint32")
	.immutable("card_type", "string")
	.immutable("mana_cost", "uint8")
	.immutable("rarity", "string")
	.immutable("hero_class", "string")
	.immutable("base_attack", "uint16")
	.immutable("base_health", "uint16")
	.immutable("keywords", "string[]")
	.immutable("edition", "string")
	.mutable("level", "uint8")
	.mutable("xp", "uint32")
	.mutable("wins", "uint32")
	.mutable("losses", "uint32")
	.build();

const collectionInput: DeterministicCollectionInput = {
	name: "Ragnarok Card Game",
	symbol: "RAGNAROK",
	creator: CREATOR,
	totalPotential: 500000,
	metadata: {
		description: "Norse mythology card game on Hive",
		image: "https://ragnarok.game/banner.png",
	},
	rules: {
		transferable: true,
		burnable: true,
		replicable: false,
		royaltyPct: 5,
		royaltyRecipient: CREATOR,
	},
	schema,
};

const collectionPayload = createDeterministicCollectionPayload(collectionInput);
const COLLECTION_ID = collectionPayload.data.id;
const ORIGIN_DNA = collectionPayload.data.originDna;

// Broadcast: toHiveOperation(collectionPayload, creator)

// ---------------------------------------------------------------
// STEP 2: Authorize game server as data operator
// ---------------------------------------------------------------

const approveOp = createDataOperatorApproveOperation(
	{ collectionId: COLLECTION_ID, operator: GAME_SERVER, approved: true },
	CREATOR,
);

// Broadcast as CREATOR

// ---------------------------------------------------------------
// STEP 3: Mint all 2,134 seeds (5 per Hive transaction)
// ---------------------------------------------------------------

interface CardDef {
	readonly artId: string;
	readonly name: string;
	readonly imageUrl: string;
	readonly maxSupply: number;
	readonly immutableData: Record<string, unknown>;
}

// Abbreviated -- in practice, load from JSON or database
const cards: ReadonlyArray<CardDef> = [
	{
		artId: "odin-allfather",
		name: "Odin, Allfather",
		imageUrl: "https://ragnarok.game/cards/001.png",
		maxSupply: 1000,
		immutableData: {
			card_id: 1,
			card_type: "hero",
			mana_cost: 8,
			rarity: "legendary",
			hero_class: "asgardian",
			base_attack: 6,
			base_health: 10,
			keywords: ["divine", "wisdom"],
			edition: "core",
		},
	},
	// ... 2,133 more cards
];

// Pre-compute all seed IDs (deterministic)
const seedMap = new Map<string, string>();
for (const card of cards) {
	seedMap.set(card.artId, generateDeterministicSeedId(COLLECTION_ID, card.artId));
}

// Build mint payloads
const mintPayloads = cards.map((card): DeterministicMintInput => ({
	artId: card.artId,
	collectionId: COLLECTION_ID,
	collectionOriginDna: ORIGIN_DNA,
	edition: 1,
	owner: CREATOR,
	name: card.name,
	imageUrl: card.imageUrl,
	maxReplicas: card.maxSupply,
	immutableData: card.immutableData,
}));

// Batch and broadcast (5 per tx, ~427 transactions)
for (let i = 0; i < mintPayloads.length; i += MAX_OPERATIONS_PER_TX) {
	const batch = mintPayloads.slice(i, i + MAX_OPERATIONS_PER_TX);
	const operations = batch.map((input) => {
		const payload = createDeterministicMintPayload(input);
		return [
			"custom_json",
			{
				required_auths: [],
				required_posting_auths: [CREATOR],
				id: "nftlox_testnet",
				json: JSON.stringify(payload),
			},
		];
	});
	// await broadcastTransaction(operations);
	// await sleep(TX_DELAY_MS);
}

// ---------------------------------------------------------------
// STEP 4: Build the drop table from full catalog
// ---------------------------------------------------------------

const RARITY_WEIGHTS: Readonly<Record<string, number>> = {
	legendary: 1,
	epic: 5,
	rare: 20,
	common: 100,
};

const dropTable = cards.map((card) => ({
	seedId: seedMap.get(card.artId)!,
	weight: RARITY_WEIGHTS[card.immutableData.rarity as string] ?? 100,
}));

// ---------------------------------------------------------------
// STEP 5: Player opens a pack
// ---------------------------------------------------------------

const CARDS_PER_PACK = 5;

async function handlePackOpen(
	player: string,
	paymentTxId: string,
	paymentBlockNum: number,
): Promise<ReadonlyArray<string>> {
	// 5a. Derive RNG seed from immutable blockchain data
	const rngSeed = `${paymentTxId}:${paymentBlockNum}:${player}`;

	// 5b. Resolve drop table locally (full 2,134-entry table, no limit)
	const resolved = resolveDropTable(
		dropTable as Array<{ seedId: string; weight: number }>,
		CARDS_PER_PACK,
		rngSeed,
	);

	// 5c. Aggregate: same seedId selected twice = quantity 2
	const counts = new Map<string, number>();
	for (const seedId of resolved) {
		counts.set(seedId, (counts.get(seedId) ?? 0) + 1);
	}
	const items = Array.from(counts.entries()).map(([seedId, quantity]) => ({
		seedId,
		quantity,
		originBlock: paymentBlockNum,
	}));

	// 5d. Broadcast bulk_distribute
	const payload = createBulkDistributePayload({ to: player, items });
	const operation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [CREATOR],
			id: "nftlox_testnet",
			json: JSON.stringify(payload),
		},
	];
	// await broadcastTransaction([operation]);

	return resolved;
}

// ---------------------------------------------------------------
// STEP 6: Verify a pack opening (anyone can do this)
// ---------------------------------------------------------------

function verifyPackOpening(
	paymentTxId: string,
	paymentBlockNum: number,
	player: string,
	expectedSeedIds: ReadonlyArray<string>,
): boolean {
	const rngSeed = `${paymentTxId}:${paymentBlockNum}:${player}`;
	const resolved = resolveDropTable(
		dropTable as Array<{ seedId: string; weight: number }>,
		CARDS_PER_PACK,
		rngSeed,
	);
	return resolved.every((id, i) => id === expectedSeedIds[i]);
}

// ---------------------------------------------------------------
// STEP 7: Update card stats after a match (as data operator)
// ---------------------------------------------------------------

async function recordMatchResult(
	winnerId: string,
	winnerDna: string,
	loserId: string,
	loserDna: string,
	xpGained: number,
): Promise<void> {
	const updates: ReadonlyArray<SetDataFromInput> = [
		{
			nftId: winnerId,
			instanceDna: winnerDna,
			mutableData: { xp: xpGained, wins: 1 },
			// Note: the indexer adds to existing values based on your game logic.
			// Typically you read current state, compute new values, then write.
		},
		{
			nftId: loserId,
			instanceDna: loserDna,
			mutableData: { xp: Math.floor(xpGained / 2), losses: 1 },
		},
	];

	const operations = updates.map((input) =>
		createSetDataFromOperation(input, GAME_SERVER),
	);
	// await broadcastTransaction(operations);
}
```

---

## Summary

| Step | Action | Frequency |
|------|--------|-----------|
| 1. Create collection | `create_collection` with schema | Once |
| 2. Approve operator | `data_operator_approve` | Once per operator |
| 3. Mint seeds | `mint` (5 per tx) | Once (2,134 cards = ~427 txs) |
| 4. Build drop table | In-memory, from card catalog | Once (cached) |
| 5. Open pack | `resolveDropTable()` + `bulk_distribute` | Per player purchase |
| 6. Verify | `resolveDropTable()` with same inputs | On demand |
| 7. Update stats | `set_data_from` (up to 5 per tx) | After each game match |

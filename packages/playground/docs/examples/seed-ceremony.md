# Seed Ceremony: Minting All Game Seeds

This example shows the complete TypeScript script for minting all game card seeds to the Hive blockchain. Seeds are non-transferable template NFTs -- when a player opens a pack, the protocol creates instances of these seeds.

**Prerequisites:**
- A Hive account with posting key
- Node.js/Bun runtime
- `nftlox-sdk` and `hive-tx` packages installed

---

## Card Catalog

Define your card database. Each card will become one seed on-chain.

```typescript
interface CardDefinition {
	readonly artId: string;       // Unique within collection, max 14 chars
	readonly name: string;
	readonly imageUrl: string;
	readonly maxSupply: number;   // Max instances that can be distributed
	readonly rarity: string;
	readonly cardType: string;
	readonly manaCost: number;
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
		rarity: "legendary",
		cardType: "hero",
		manaCost: 8,
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
		rarity: "common",
		cardType: "minion",
		manaCost: 5,
		heroClass: "neutral",
		baseAttack: 4,
		baseHealth: 6,
		keywords: ["jotun"],
		edition: "core",
	},
	{
		artId: "valkyrie-shield",
		name: "Valkyrie Shield",
		imageUrl: "https://ragnarok.game/cards/valkyrie-shield.png",
		maxSupply: 5000,
		rarity: "rare",
		cardType: "spell",
		manaCost: 3,
		heroClass: "asgardian",
		baseAttack: 0,
		baseHealth: 0,
		keywords: ["shield", "divine"],
		edition: "core",
	},
	{
		artId: "loki-trickster",
		name: "Loki, Trickster",
		imageUrl: "https://ragnarok.game/cards/loki-trickster.png",
		maxSupply: 1500,
		rarity: "epic",
		cardType: "hero",
		manaCost: 6,
		heroClass: "asgardian",
		baseAttack: 4,
		baseHealth: 7,
		keywords: ["trickery", "illusion"],
		edition: "core",
	},
	{
		artId: "mjolnir",
		name: "Mjolnir",
		imageUrl: "https://ragnarok.game/cards/mjolnir.png",
		maxSupply: 2000,
		rarity: "epic",
		cardType: "weapon",
		manaCost: 7,
		heroClass: "asgardian",
		baseAttack: 8,
		baseHealth: 0,
		keywords: ["lightning", "divine"],
		edition: "core",
	},
	// ... add remaining cards
];
```

---

## Full Script

```typescript
import {
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateOriginDna,
	createSchemaBuilder,
	MAX_OPERATIONS_PER_TX,
	TX_DELAY_MS,
	PROTOCOL_ID,
	type DeterministicCollectionInput,
	type DeterministicMintInput,
	type CollectionSchema,
} from "nftlox-sdk";
import hive from "hive-tx";

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const CREATOR = "ragnarok-game";
const POSTING_KEY = process.env.HIVE_POSTING_KEY!;
const HIVE_RPC = "https://api.hive.blog";

if (!POSTING_KEY) {
	throw new Error("Set HIVE_POSTING_KEY environment variable");
}

hive.config.set("uri", HIVE_RPC);

// ---------------------------------------------------------------
// Step 1: Define the schema
// ---------------------------------------------------------------

const cardSchema: CollectionSchema = createSchemaBuilder()
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

// ---------------------------------------------------------------
// Step 2: Create the collection
// ---------------------------------------------------------------

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
		royaltyPct: 5,
		royaltyRecipient: CREATOR,
	},
	schema: cardSchema,
};

const collectionPayload = createDeterministicCollectionPayload(collectionInput);
const COLLECTION_ID = collectionPayload.data.id;
const ORIGIN_DNA = collectionPayload.data.originDna;

console.log(`Collection ID: ${COLLECTION_ID}`);
console.log(`Origin DNA: ${ORIGIN_DNA}`);

// ---------------------------------------------------------------
// Step 3: Broadcast collection creation
// ---------------------------------------------------------------

async function broadcastOperations(
	operations: Array<[string, Record<string, unknown>]>,
): Promise<string> {
	const tx = new hive.Transaction();
	tx.create(operations);
	tx.sign(hive.PrivateKey.from(POSTING_KEY));
	const result = await tx.broadcast();

	if (result?.error) {
		throw new Error(`Broadcast failed: ${JSON.stringify(result.error)}`);
	}

	return result?.result?.tx_id ?? "unknown";
}

async function createCollection(): Promise<void> {
	const operation: [string, Record<string, unknown>] = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [CREATOR],
			id: PROTOCOL_ID,
			json: JSON.stringify(collectionPayload),
		},
	];

	const txId = await broadcastOperations([operation]);
	console.log(`Collection created: txId=${txId}`);
}

// ---------------------------------------------------------------
// Step 4: Build mint payloads for all cards
// ---------------------------------------------------------------

function buildMintPayload(
	card: CardDefinition,
	cardIndex: number,
): DeterministicMintInput {
	return {
		artId: card.artId,
		collectionId: COLLECTION_ID,
		collectionOriginDna: ORIGIN_DNA,
		edition: cardIndex + 1,
		owner: CREATOR,
		name: card.name,
		imageUrl: card.imageUrl,
		maxSupply: card.maxSupply,
		immutableData: {
			card_id: cardIndex + 1,
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

// ---------------------------------------------------------------
// Step 5: Mint all seeds in batches of 5
// ---------------------------------------------------------------

function chunkArray<T>(arr: ReadonlyArray<T>, size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mintAllSeeds(): Promise<void> {
	const mintInputs = CARD_CATALOG.map((card, i) => buildMintPayload(card, i));
	const batches = chunkArray(mintInputs, MAX_OPERATIONS_PER_TX);

	const totalBatches = batches.length;
	console.log(`Minting ${CARD_CATALOG.length} seeds in ${totalBatches} batches...`);

	for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
		const batch = batches[batchIdx]!;

		const operations: Array<[string, Record<string, unknown>]> = batch.map(
			(input) => {
				const payload = createDeterministicMintPayload(input);
				return [
					"custom_json",
					{
						required_auths: [],
						required_posting_auths: [CREATOR],
						id: PROTOCOL_ID,
						json: JSON.stringify(payload),
					},
				];
			},
		);

		try {
			const txId = await broadcastOperations(operations);
			const seedIds = batch.map((input) =>
				generateDeterministicSeedId(COLLECTION_ID, input.artId),
			);
			console.log(
				`Batch ${batchIdx + 1}/${totalBatches}: txId=${txId}, seeds=[${seedIds.join(", ")}]`,
			);
		} catch (error) {
			console.error(`Batch ${batchIdx + 1} failed:`, error);
			// In production, implement retry logic here
			throw error;
		}

		// Wait for block confirmation between batches
		if (batchIdx < batches.length - 1) {
			await sleep(TX_DELAY_MS);
		}
	}

	console.log("All seeds minted.");
}

// ---------------------------------------------------------------
// Step 6: Verify seeds via API
// ---------------------------------------------------------------

async function verifySeeds(): Promise<void> {
	const API_BASE = "https://api-nftlox.hivecreators.co";

	const response = await fetch(
		`${API_BASE}/api/users/${CREATOR}/nfts?limit=200`,
	);
	const data = await response.json();

	console.log(`\nVerification: found ${data.nfts.length} NFTs for ${CREATOR}`);

	const seeds = data.nfts.filter((nft: { nft_type: string }) => nft.nft_type === "seed");
	console.log(`Seeds: ${seeds.length}`);

	// Verify each expected seed ID exists
	let missingCount = 0;
	for (const card of CARD_CATALOG) {
		const expectedSeedId = generateDeterministicSeedId(
			COLLECTION_ID,
			card.artId,
		);
		const found = seeds.find(
			(s: { id: string }) => s.id === expectedSeedId,
		);
		if (!found) {
			console.warn(`Missing seed: ${card.artId} (expected ${expectedSeedId})`);
			missingCount++;
		}
	}

	if (missingCount === 0) {
		console.log("All seeds verified on-chain.");
	} else {
		console.warn(`${missingCount} seeds missing. Check indexer sync status.`);
	}
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main(): Promise<void> {
	console.log("=== NFTLox Seed Ceremony ===\n");

	// Pre-compute all seed IDs for reference
	console.log("Pre-computed seed IDs:");
	for (const card of CARD_CATALOG) {
		const seedId = generateDeterministicSeedId(COLLECTION_ID, card.artId);
		console.log(`  ${card.artId} -> ${seedId}`);
	}
	console.log();

	// Step 1: Create collection
	await createCollection();
	await sleep(TX_DELAY_MS);

	// Step 2: Mint all seeds
	await mintAllSeeds();

	// Step 3: Wait a bit for indexer to process, then verify
	console.log("\nWaiting 10 seconds for indexer to process...");
	await sleep(10000);
	await verifySeeds();
}

main().catch(console.error);
```

---

## Step-by-Step Explanation

### 1. Schema Definition

The schema defines which fields are immutable (set at mint, copied to all instances) and which are mutable (updated during gameplay). The schema must be included in the collection creation payload.

```typescript
const cardSchema = createSchemaBuilder()
	.immutable("card_id", "uint32")     // Set once, inherited by instances
	.mutable("level", "uint8")          // Updated by game server
	.build();
```

### 2. Collection Creation

`createDeterministicCollectionPayload` generates a collection payload where the `collectionId` is deterministic: the same `creator + name + symbol` always produces the same ID. This prevents accidental duplicate collections.

### 3. Mint Payload Construction

Each card in your catalog becomes a `DeterministicMintInput`. The `immutableData` field contains all on-chain card stats. When instances are created later (via `bulk_distribute`), they inherit these values automatically.

The `artId` field is the card's unique identifier within the collection (max 14 characters). Together with `collectionId`, it deterministically produces the `seedId`.

### 4. Batching

Hive limits `custom_json` operations to 5 per transaction (`MAX_OPERATIONS_PER_TX`). The script chunks the card catalog into batches of 5 and broadcasts each batch as a separate transaction.

Between batches, it waits `TX_DELAY_MS` (4000ms) for block confirmation. A Hive block is produced every 3 seconds, so 4 seconds provides a safety margin.

### 5. Timing

| Cards | Batches | Time (approx.) |
|-------|---------|-----------------|
| 5 | 1 | 4 seconds |
| 100 | 20 | 80 seconds |
| 500 | 100 | ~7 minutes |
| 2,134 | 427 | ~28 minutes |

This is a one-time cost. Once seeds are minted, they exist permanently on-chain.

### 6. Verification

After minting, query the indexer API to confirm all seeds exist. Since seed IDs are deterministic, you can pre-compute expected IDs and check each one against the API response.

---

## Using the Playground API Instead

If you prefer not to manage Hive signing directly, you can use the playground's build endpoints to construct the operations, then sign and broadcast them separately:

```typescript
// Build seeds via the playground API
const response = await fetch("https://nftloxtest.hivecreators.co/api/build/seeds", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		collectionId: COLLECTION_ID,
		owner: CREATOR,
		seeds: CARD_CATALOG.map((card) => ({
			artId: card.artId,
			name: card.name,
			imageUrl: card.imageUrl,
			maxSupply: card.maxSupply,
		})),
	}),
});

const result = await response.json();
// result.batches contains pre-grouped operations ready for signing
```

The API returns operations grouped into batches of 5. Sign each batch with your posting key and broadcast sequentially.

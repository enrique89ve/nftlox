# Game Development with NFTLox

Build games with on-chain NFTs that have functional DNA, mutable stats, and provable ownership—all without smart contracts, gas fees, or oracles.

---

## Architecture Overview

NFTLox is built for game developers who want **on-chain ownership** without the complexity of smart contracts.

```
Game Server              Hive L1              NFTLox Indexer
    │                       │                      │
    ├─ Build payload ──────►│                      │
    │                       │                      │
    │         Sign & broadcast (custom_json)       │
    │                       │                      │
    │                       ├─ Validate ──────────►│
    │                       │                      │
    │                       │                ← Store state
    │                       │                      │
    │◄─ Query API ──────────────────────────────────┤
    │ (collections, NFTs,                          │
    │  marketplace, ownership)                     │
```

**Key insights:**
- Game server owns the backend keys and calls the SDK directly (no Keychain).
- SDK generates **unsigned** payloads; server signs and broadcasts via Hive RPC.
- Indexer validates everything on-chain; no backend database needed for truth.
- Mutable data (stats, level, xp) updated via `set_data` or `set_data_from` (operator pattern).
- Ownership verified trustlessly via SPV (client-side verification against Hive L1).

---

## 1. Collection & Schema Design for Games

Define your NFT types upfront with **typed schemas**—immutable stats (rarity, class) stay locked; mutable stats (level, xp, durability) update in real time.

### Example: RPG Loot System

```typescript
import { buildCollection, GAMING_SCHEMA } from "@nftlox/sdk";

const lootCollection = await buildCollection({
	creator: "game-treasury",
	name: "Mystic Loot",
	symbol: "LOOT",
	totalPotential: 10000,
	metadata: {
		description: "In-game equipment with dynamic stats",
		image: "https://example.com/loot-banner.png",
		externalUrl: "https://game.example.com",
	},
	rules: {
		transferable: true,
		burnable: false, // Loot cannot be destroyed; must be returned to treasury
		royaltyPct: 5,
		royaltyRecipient: "game-treasury",
	},
	schema: {
		immutable: [
			{ name: "item_type", type: "string" }, // "sword", "shield", "helmet"
			{ name: "rarity", type: "string" },    // "common", "rare", "epic", "legendary"
			{ name: "base_attack", type: "uint16" },
			{ name: "base_defense", type: "uint16" },
		],
		mutable: [
			{ name: "level", type: "uint8" },
			{ name: "durability", type: "uint16" },
			{ name: "owner_level", type: "uint8" }, // minimum level to equip
			{ name: "enchantments", type: "string[]" },
		],
	},
});

console.log(`✓ Loot collection: ${lootCollection.generatedIds.collectionId}`);
```

---

## 2. Automated Collection + Seeds

For bulk NFT creation at launch, use `buildCollectionWithSeeds` to generate a collection and 100s of seed templates in one go, with automatic batching.

### Example: 250 Hero Cards

```typescript
import { buildCollectionWithSeeds } from "@nftlox/sdk";

const plan = await buildCollectionWithSeeds(
	{
		creator: "game-admin",
		name: "Heroes of Mystica",
		symbol: "HERO",
		totalPotential: 250,
		metadata: {
			description: "Playable hero characters",
			image: "https://example.com/heroes.png",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct: 2.5,
			royaltyRecipient: "game-treasury",
		},
		schema: {
			immutable: [
				{ name: "hero_class", type: "string" },
				{ name: "rarity", type: "string" },
				{ name: "base_hp", type: "uint16" },
			],
			mutable: [
				{ name: "current_level", type: "uint8" },
				{ name: "experience", type: "uint32" },
			],
		},
		seeds: [
			{
				artId: "hero-warrior-001",
				name: "Kael the Brave",
				imageUrl: "https://example.com/heroes/kael.png",
				maxSupply: 500,
				brief: "Legendary warrior",
				immutableData: {
					hero_class: "Warrior",
					rarity: "legendary",
					base_hp: 150,
				},
			},
			// ... 249 more heroes
		],
		owner: "game-treasury",
	},
	{
		nodeAccount: "nftlox",
		feeCurrency: "HBD",
		feeAmount: "0.100",
	},
);

if (!plan.success) {
	console.error("Build failed:", plan.errors);
	return;
}

console.log(`✓ Collection: ${plan.collectionId}`);
console.log(`✓ Seeds: ${plan.totalSeedCount} heroes`);
console.log(`✓ Batches: ${plan.seedBatches.length}`);

// Now sign and broadcast step 1 (collection creation, requires active key)
// Then broadcast seedBatches 1..N (each requires posting key)
```

---

## 3. Instance Distribution

When a player earns or purchases an item, distribute an **instance** from a seed using `bulk_distribute`.

```typescript
import { buildBulkDistribute } from "@nftlox/sdk";

// Player loots 3 items after defeating a boss
const loot = await buildBulkDistribute({
	signer: "game-loot-engine",
	to: "player-alice",
	items: [
		{ seedId: "seed_sword_001", quantity: 1, seedTxId: "tx_hash_1" },
		{ seedId: "seed_shield_001", quantity: 2, seedTxId: "tx_hash_2" },
	],
	mutableData: {
		level: 1,
		durability: 100,
		enchantments: [],
	},
});

if (loot.success) {
	// loot.operation is ready to sign and broadcast
	console.log(`✓ Distributed 3 items to player-alice`);
}
```

**Key point:** Each instance gets a unique `instanceDna` and `instanceNumber`. The player now owns three distinct NFTs that can be transferred, listed, or lent independently.

---

## 4. Mutable Data & Game State

Update in-game stats on-chain via `set_data` (creator) or `set_data_from` (if game server is an approved operator).

### As Collection Creator

```typescript
import { buildSetData } from "@nftlox/sdk";

// Update player level and experience
const update = await buildSetData({
	nftId: "nft_hero_001",
	creator: "game-admin",
	mutableData: {
		current_level: 5,
		experience: 2500,
	},
});
```

### As Data Operator (Game Server)

For scalability, approve your game server as a **data operator** once, then it can update all NFTs without requiring the creator's key.

```typescript
import { buildDataOperatorApprove, buildSetDataFrom } from "@nftlox/sdk";

// Step 1: Creator approves game server (one-time, per collection)
const approval = await buildDataOperatorApprove({
	creator: "game-admin",
	collectionId: "col_heroes_001",
	operator: "game-server-account",
	approved: true,
});

// Step 2: Game server updates mutable data (repeatable, low-cost)
const serverUpdate = await buildSetDataFrom({
	operator: "game-server-account",
	nftId: "nft_hero_001",
	instanceDna: "A3F7B2C1...", // from the NFT's proof
	mutableData: {
		current_level: 6,
		experience: 3500,
	},
});
```

**Shallow merge behavior:** Mutable data is shallow-merged; omitted fields retain their old values. So you can update one field without re-sending everything.

---

## 5. Lending & Tournaments

Enable guild banks, rental systems, or tournament loot shares via peer-to-peer lending.

```typescript
import { buildNftLend, buildNftReturn } from "@nftlox/sdk";

// Player lends hero to friend for 7 days
const lend = await buildNftLend({
	signer: "player-alice",
	nftId: "nft_hero_001",
	borrower: "player-bob",
	durationDays: 7,
});

// 7 days later, player-bob returns it
const lendReturn = await buildNftReturn({
	signer: "player-bob",
	nftId: "nft_hero_001",
});
```

**Use cases:**
- Guild banks: Members lend gear to new recruits.
- Tournament prize splits: Winners lend items to co-winners temporarily.
- Try-before-you-buy: Marketplace lends high-value items for a fee.

---

## 6. Marketplace Integration

List items for sale with royalty enforcement on every transaction.

```typescript
import { buildList, createIndexerClient, buildBuy } from "@nftlox/sdk";

// Player lists sword for 10 HIVE
const listing = await buildList({
	signer: "player-alice",
	nftId: "nft_sword_001",
	price: { amount: "10", currency: "HIVE" },
	memo: "Legendary sword - great for bosses",
});

// Buyer queries payment split first
const indexer = createIndexerClient("https://api-nftlox.hivecreators.co");
const paymentInfo = await indexer.getPaymentInfo("nft_sword_001");
// { seller: "9.75 HIVE", royalty: "0.25 HIVE" }

// Buyer builds buy transaction (multisig with node)
const buy = await buildBuy({
	buyer: "player-bob",
	nftId: "nft_sword_001",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
});
```

---

## 7. Ownership Verification (SPV)

Let players trustlessly verify item ownership on their client without trusting the indexer.

```typescript
import { verifyNftOwnership, createDefaultL1Config } from "@nftlox/sdk";

// Player verifies they own an item (samples up to 3 events from Hive L1)
const proof = await verifyNftOwnership({
	nftId: "nft_hero_001",
	expectedOwner: "player-alice",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config: createDefaultL1Config(),
});

if (proof.status === "verified") {
	console.log(`✓ Verified: player-alice owns nft_hero_001`);
	console.log(`  Verified at block: ${proof.verifiedAtBlock}`);
} else {
	console.error(`✗ Verification failed: ${proof.message}`);
}
```

---

## 8. Backend Workflow: Full Example

Here's a complete backend flow using `hive-tx` for signing:

```typescript
import * as HiveTx from "@hiveio/wax";
import {
	buildCollectionWithSeeds,
	buildBulkDistribute,
	buildSetDataFrom,
	buildNftLend,
	createIndexerClient,
} from "@nftlox/sdk";

const indexer = createIndexerClient("https://api-nftlox.hivecreators.co");

// 1. Create collection + seeds
const plan = await buildCollectionWithSeeds(
	{
		creator: "my-game",
		name: "Game Assets",
		symbol: "ASSET",
		totalPotential: 5000,
		metadata: { description: "Game items", image: "..." },
		rules: { transferable: true, burnable: true, royaltyPct: 2.5 },
		schema: {
			immutable: [{ name: "item_type", type: "string" }],
			mutable: [{ name: "level", type: "uint8" }],
		},
		seeds: [
			{
				artId: "sword-001",
				name: "Iron Sword",
				imageUrl: "...",
				maxSupply: 1000,
				brief: "Basic sword",
				immutableData: { item_type: "sword" },
			},
		],
	},
	{ nodeAccount: "nftlox", feeCurrency: "HBD", feeAmount: "0.100" },
);

// 2. Sign & broadcast collection step
const creatorKey = process.env.CREATOR_ACTIVE_KEY!;
const collectionTx = HiveTx.createHiveChain()
	.addOperation(...plan.collectionStep.operations)
	.addTaPoS()
	.addExpiration(30);

const signedTx = collectionTx
	.sign(HiveTx.createPrivateKeyManager([creatorKey]))
	.finalize();

// Request node co-signature for multisig
const multisigRes = await fetch(
	"https://api-nftlox.hivecreators.co/api/multisig",
	{
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ transaction: signedTx }),
	},
);
const { signature: nodeSignature } = await multisigRes.json();
const finalTx = HiveTx.updateSignature(signedTx, nodeSignature);

const client = HiveTx.createClient("https://api.hive.blog");
await client.broadcast.sendChainTransaction(finalTx);

console.log(`✓ Collection created: ${plan.collectionId}`);

// 3. Broadcast seed batches (posting key)
const posterKey = process.env.GAME_POSTING_KEY!;
for (const batch of plan.seedBatches) {
	const seedTx = HiveTx.createHiveChain()
		.addOperation(...batch.operations)
		.addTaPoS()
		.addExpiration(30)
		.sign(HiveTx.createPrivateKeyManager([posterKey]))
		.finalize();

	await client.broadcast.sendChainTransaction(seedTx);
	console.log(`✓ Batch ${batch.batchNumber} broadcast (${batch.seeds.length} seeds)`);
	await new Promise((r) => setTimeout(r, 3000)); // Wait for indexer to catch up
}

// 4. Distribute instance to player
const distribute = await buildBulkDistribute({
	signer: "my-game",
	to: "player-username",
	items: [{ seedId: plan.generatedIds["sword-001"], quantity: 1, seedTxId: "..." }],
	mutableData: { level: 1 },
});

const distTx = HiveTx.createHiveChain()
	.addOperation(...distribute.operations)
	.addTaPoS()
	.addExpiration(30)
	.sign(HiveTx.createPrivateKeyManager([posterKey]))
	.finalize();

await client.broadcast.sendChainTransaction(distTx);

console.log("✓ Game assets ready!");
```

---

## 9. Key Architecture Patterns

| Pattern | Use Case | Key Type | Example |
|---|---|---|---|
| **Direct ownership** | Player gets item | Posting | `bulk_distribute` |
| **Data operator** | Game updates stats at scale | Posting | Game server as operator |
| **Lending** | Guild bank, rentals | Posting | `nft_lend` / `nft_return` |
| **Marketplace** | Player trading | Active (`buy`) + Posting | List → Buy with multisig |
| **Approval** | Delegation (future) | Posting | `nft_approve` for trade contracts |
| **SPV** | Trustless proof | None (client-side) | `verifyNftOwnership` |

---

## Next Steps

1. **Start with a schema:** Define your NFT fields in [Collections](../concepts/collections.md).
2. **Learn the builders:** See [SDK Reference](../sdk/reference.md) for all builders.
3. **Study examples:** [Card Game](../examples/games/card-game.md) and [Item System](../examples/games/item-system.md) show end-to-end flows.
4. **Broadcast:** Use `hive-tx`, `@hiveio/dhive`, or `@hiveio/wax` per [Broadcasting](../broadcasting.md).
5. **Deploy:** Contact the core team for testnet access and production launch planning.

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
import { buildCollection } from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

const lootCollection = await buildCollection(
	{
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
	},
	{
		indexerBaseUrl: INDEXER_URL,
		feeCurrency: "HBD",
		feeAmount: "0.100",
	},
);

if (!lootCollection.success) {
	throw new Error(`Collection build failed: ${JSON.stringify(lootCollection.errors)}`);
}

console.log(`✓ Loot collection: ${lootCollection.generatedIds?.collectionId}`);
```

---

## 2. Automated Collection + Seeds

For bulk NFT creation at launch, use `buildCollectionWithSeeds` to generate a collection and 100s of seed templates in one go, with automatic batching.

### Example: 250 Hero Cards

```typescript
import { buildCollectionWithSeeds } from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

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
		indexerBaseUrl: INDEXER_URL,
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
import { buildBulkDistribute } from "nftlox-sdk";

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

Update in-game stats via `set_data` (NFT owner) or `set_data_from` (approved data operator).

### As NFT owner

```typescript
import { buildSetData, createIndexerClient } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");
const nft = await client.getNft("nft_hero_001");

// instanceDna is required — it binds the write to the current NFT state
const update = buildSetData({
	owner: "game-admin",
	nftId: "nft_hero_001",
	instanceDna: nft.instance_dna!,
	mutableData: {
		current_level: 5,
		experience: 2500,
	},
});
```

### As data operator (game server)

Approve the game server once, then it can update any NFT in the collection with its own posting key — no player keys needed.

```typescript
import { buildDataOperatorApprove, buildSetDataFrom, createIndexerClient } from "nftlox-sdk";

// Step 1: Creator approves game server (one-time, per collection)
// Signed by collection creator's posting key
const approval = buildDataOperatorApprove({
	creator: "game-admin",
	collectionId: "col_heroes_001",
	operator: "game-server-account",
	approved: true,
});

// Step 2: Game server updates mutable data (repeatable)
// Signed by game-server-account's posting key
const client = createIndexerClient("https://api-nftlox.hivecreators.co");
const nft = await client.getNft("nft_hero_001");

const serverUpdate = buildSetDataFrom({
	operator: "game-server-account",
	nftId: "nft_hero_001",
	instanceDna: nft.instance_dna!,
	mutableData: {
		current_level: 6,
		experience: 3500,
	},
});
```

**Shallow merge:** mutableData is merged key-by-key. Omitted fields keep their current values — you only send what changed.

---

## 5. Lending & Tournaments

Non-custodial lending — the lender keeps ownership, borrower gets a scoped right of use. Duration enforcement is off-chain (no protocol time-lock). Signed by the owner to lend, signed by the borrower to return.

```typescript
import { buildNftLend, buildNftReturn } from "nftlox-sdk";

// Owner lends instance to player-bob (signed with owner's posting key)
const lend = buildNftLend({
	owner: "player-alice",
	instanceId: "nft_hero_001",  // note: instanceId, not nftId
	borrower: "player-bob",
});
if (!lend.success) throw new Error(JSON.stringify(lend.errors));

// player-bob returns it (signed with bob's posting key)
const lendReturn = buildNftReturn({
	owner: "player-bob",         // the borrower; "owner" is the signer here
	instanceId: "nft_hero_001",
});
if (!lendReturn.success) throw new Error(JSON.stringify(lendReturn.errors));
```

While lent: transfers, listings, and new approvals are blocked. `set_data` still works (XP keeps accumulating on the lender's NFT). Only the borrower can call `buildNftReturn`.

**Use cases:**
- Guild banks: lend gear to new recruits with social trust.
- Paid rentals: borrow pays off-chain; your backend calls `buildNftReturn` at expiry.
- Tournament whitelist: lend a legendary card for the weekend; XP earned accrues to the owner.

---

## 6. Marketplace Integration

Listings are posting-only. Buys require active key + node co-signature. Always read the payment split from the indexer — never compute it yourself.

```typescript
import { buildList, buildBuy, createIndexerClient, MultisigError } from "nftlox-sdk";
import hive from "hive-tx";

hive.config.set("node", "https://api.hive.blog");

// --- LISTING (posting key, single-signer) ---
const listing = await buildList({
	owner: "player-alice",         // note: owner, not signer
	nftId: "nft_sword_001",
	price: { amount: "10.000", currency: "HIVE" }, // 3-decimal string
	marketplace: "my-game",        // optional scope tag
});
if (!listing.success) throw new Error(JSON.stringify(listing.errors));
// listing.generatedIds.listingId  — precomputed, no broadcast yet needed

// --- BUYING (active key + node multisig) ---
const client = createIndexerClient("https://api-nftlox.hivecreators.co");
const info = await client.getPaymentInfo("nft_sword_001");

const buy = buildBuy({
	buyer: "player-bob",
	seller: info.seller,
	nftId: info.nftId,
	listingId: info.listingId,
	listTxId: info.listTxId,
	txId: info.txId,
	paymentSplit: {
		sellerAmount: info.sellerAmount,
		royaltyAmount: info.royaltyAmount,
		royaltyRecipient: info.royaltyRecipient,
		feeAmount: info.feeAmount,
		feeAccount: info.feeAccount,
		totalPrice: info.totalPrice,
		currency: info.currency as "HIVE" | "HBD",
	},
});
if (!buy.success) throw new Error(JSON.stringify(buy.errors));

const tx = new hive.Transaction();
await tx.create(buy.operations as [string, object][]);
const resp = await client.multisig({
	buyer: "player-bob", nftId: info.nftId,
	listingId: info.listingId, listTxId: info.listTxId,
	transaction: tx.transaction,
});
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: "…" });
tx.transaction.signatures.push(resp.signature);
tx.sign(hive.PrivateKey.from(process.env.PLAYER_BOB_ACTIVE_KEY!));
await tx.broadcast();
```

---

## 7. Ownership Verification (SPV)

Let players trustlessly verify item ownership on their client without trusting the indexer.

```typescript
import { verifyNftOwnership, createDefaultL1Config } from "nftlox-sdk";

// Player verifies they own an item (samples up to 3 events from Hive L1)
const proof = await verifyNftOwnership({
	nftId: "nft_hero_001",
	expectedOwner: "player-alice",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config: createDefaultL1Config(),
});

if (proof.status === "verified") {
	console.log(`✓ Verified: player-alice owns nft_hero_001`);
	console.log(`  Duration: ${proof.durationMs}ms`);
} else {
	console.error(`✗ Verification failed: ${proof.message}`);
}
```

---

## 8. Backend Workflow: Full Example

Full launch flow using `hive-tx`:

```typescript
import {
	buildCollectionWithSeeds,
	buildBulkDistribute,
	createIndexerClient,
	requestCreateCollectionMultisig,
	MultisigError,
} from "nftlox-sdk";
import hive from "hive-tx";

hive.config.set("node", "https://api.hive.blog");

const INDEXER_URL = "https://api-nftlox.hivecreators.co";
const ACTIVE_KEY  = hive.PrivateKey.from(process.env.CREATOR_ACTIVE_KEY!);
const POSTING_KEY = hive.PrivateKey.from(process.env.GAME_POSTING_KEY!);

async function broadcast(ops: readonly unknown[], key: typeof ACTIVE_KEY) {
	const tx = new hive.Transaction();
	await tx.create(ops as [string, object][]);
	tx.sign(key);
	const res = await tx.broadcast();
	if (res?.error) throw new Error(JSON.stringify(res.error));
	return res.result.tx_id as string;
}

// 1. Plan collection + seeds
const plan = await buildCollectionWithSeeds(
	{
		creator: "my-game",
		name: "Game Assets",
		symbol: "ASSET",
		totalPotential: 5000,
		metadata: { description: "Game items", image: "https://…/cover.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 2.5 },
		schema: {
			immutable: [{ name: "item_type", type: "string" }],
			mutable: [{ name: "level", type: "uint8" }],
		},
		seeds: [{
			artId: "sword-001",
			name: "Iron Sword",
			imageUrl: "https://…/sword.png",
			maxSupply: 1000,
			brief: "Basic sword",
			immutableData: { item_type: "sword" },
		}],
	},
	{ indexerBaseUrl: INDEXER_URL, feeCurrency: "HBD", feeAmount: "0.100" },
);
if (!plan.success) throw new Error(JSON.stringify(plan.errors));

// 2. Collection step (active + node multisig)
const colTx = new hive.Transaction();
await colTx.create(plan.collectionStep.operations as [string, object][]);
const sig = await requestCreateCollectionMultisig(INDEXER_URL, { transaction: colTx.transaction });
if (!sig.ok) throw new MultisigError({ message: sig.message, code: sig.code, url: INDEXER_URL });
colTx.transaction.signatures.push(sig.signature);
colTx.sign(ACTIVE_KEY);
const colTxId = (await colTx.broadcast()).result.tx_id as string;
console.log(`Collection: ${plan.collectionId}`);

// 3. Seed batches (posting key)
for (const batch of plan.seedBatches) {
	await broadcast(batch.operations, POSTING_KEY);
	console.log(`Batch ${batch.batchNumber}: ${batch.seeds.length} seeds`);
	await new Promise(r => setTimeout(r, 4000));
}

// 4. Distribute instances to a player
const dist = buildBulkDistribute({
	signer: "my-game",
	to: "player-username",
	items: [{ seedId: plan.generatedIds["sword-001"]!, quantity: 1, seedTxId: colTxId }],
	mutableData: { level: 1 },
});
if (!dist.success) throw new Error(JSON.stringify(dist.errors));
await broadcast(dist.operations, POSTING_KEY);
console.log("Game assets ready!");
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

1. **Start with a schema:** [Collections](../concepts/collections.md) — design immutable/mutable fields.
2. **Learn the builders:** [SDK Reference](../sdk/reference.md) — full builder table.
3. **Study examples:** [Card Game](../examples/games/card-game.md) — full TCG flow (launch → packs → trading → lending).
4. **Broadcast:** [Signing & Broadcasting](../broadcasting.md) — hive-tx / dhive / wax / Keychain.
5. **Quick LLM reference:** [LLM Context](../llm.md) — all builders, patterns, and error codes in one file.

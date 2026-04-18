# Example: Card Game (TCG)

Complete end-to-end example for a trading card game using `buildCollectionWithSeeds`, pack opening, trading, and seasonal updates.

---

## Setup: 50 Hero Cards

Create 50 unique hero cards at launch with one SDK call:

```typescript
import { buildCollectionWithSeeds } from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

const collectionPlan = await buildCollectionWithSeeds(
	{
		creator: "card-game-admin",
		name: "Mythic Heroes",
		symbol: "HERO",
		totalPotential: 50,
		metadata: {
			description: "Collectible hero cards for Mythic TCG",
			image: "https://example.com/heroes-banner.png",
			externalUrl: "https://mythic-tcg.example.com",
		},
		rules: {
			transferable: true,
			burnable: false,
			royaltyPct: 5,
			royaltyRecipient: "card-game-treasury",
		},
		schema: {
			immutable: [
				{ name: "card_number", type: "uint16" }, // 1-50
				{ name: "rarity", type: "string" }, // common, rare, epic, legendary
				{ name: "hero_type", type: "string" }, // warrior, mage, rogue, etc
				{ name: "attack_power", type: "uint16" },
				{ name: "defense_power", type: "uint16" },
			],
			mutable: [
				{ name: "wins", type: "uint32" },
				{ name: "losses", type: "uint32" },
				{ name: "deck_season", type: "uint8" }, // current season
				{ name: "rank", type: "uint8" }, // player rank using card
			],
		},
		seeds: [
			{
				artId: "hero-001-warrior",
				name: "Kael the Fearless",
				imageUrl: "https://example.com/cards/kael.png",
				maxSupply: 5000,
				brief: "Legendary warrior hero",
				immutableData: {
					card_number: 1,
					rarity: "legendary",
					hero_type: "warrior",
					attack_power: 9,
					defense_power: 7,
				},
			},
			{
				artId: "hero-002-mage",
				name: "Lyra the Arcane",
				imageUrl: "https://example.com/cards/lyra.png",
				maxSupply: 5000,
				brief: "Legendary mage hero",
				immutableData: {
					card_number: 2,
					rarity: "legendary",
					hero_type: "mage",
					attack_power: 8,
					defense_power: 4,
				},
			},
			// ... 48 more cards defined here
		],
		owner: "card-game-treasury",
	},
	{
		indexerBaseUrl: INDEXER_URL,
		feeCurrency: "HBD",
		feeAmount: "0.100",
	},
);

if (!collectionPlan.success) {
	throw new Error(`Collection plan failed: ${JSON.stringify(collectionPlan.errors)}`);
}

console.log(
	`Created ${collectionPlan.totalSeedCount} hero seeds in ${collectionPlan.seedBatches.length} batches`,
);
```

---

## Pack Opening: Distribute Cards to Players

When a player opens a booster pack, use the packs engine to select cards deterministically from the player's claim transaction, then distribute the selected seed instances:

```typescript
import { buildBulkDistribute } from "nftlox-sdk";
import {
	buildPackOpenPlan,
	computeReservedSupply,
	createPackDefinition,
} from "nftlox-packs-engine";

type PackClaim = Readonly<{
	txId: string;
	operationId: string;
	blockNum: number;
	owner: string;
	quantity: number;
}>;

// Fill this map when seed batches are broadcast:
// seedTxIdBySeedId.set(seed.seedId, broadcastResult.txId)
const seedTxIdBySeedId = new Map<string, string>();

const requireSeedTxId = (seedId: string): string => {
	const txId = seedTxIdBySeedId.get(seedId);
	if (!txId) throw new Error(`Missing seed tx id for ${seedId}`);
	return txId;
};

const requireSeedId = (artId: string): string => {
	const seedId = collectionPlan.generatedIds[artId];
	if (!seedId) throw new Error(`Missing seed id for ${artId}`);
	return seedId;
};

const boosterPack = await createPackDefinition({
	collectionId: collectionPlan.collectionId,
	name: "Mythic Booster",
	itemsPerPack: 5,
	maxSupply: 1000,
	dropTable: [
		{ seedId: requireSeedId("hero-001-warrior"), weight: 5 },
		{ seedId: requireSeedId("hero-002-mage"), weight: 5 },
		// ... remaining hero seeds with their rarity weights
	],
});

const reservedSupply = computeReservedSupply(boosterPack);

async function openBoosterPack(claim: PackClaim) {
	const seedSnapshots = boosterPack.dropTable.map(({ seedId }) => ({
		seedId,
		seedTxId: requireSeedTxId(seedId),
		maxSupply: 5000,
		distributed: 0,
		reserved: reservedSupply[seedId] ?? 0,
	}));

	const openPlan = buildPackOpenPlan({
		definition: boosterPack,
		seedSnapshots,
		context: {
			txId: claim.txId,
			operationId: claim.operationId,
			blockNum: claim.blockNum,
			owner: claim.owner,
			quantity: claim.quantity,
		},
		reservationAvailabilityBySeed: reservedSupply,
	});

	const distribution = await buildBulkDistribute({
		signer: "card-game-treasury",
		to: claim.owner,
		items: openPlan.items,
		mutableData: {
			wins: 0,
			losses: 0,
			deck_season: 1,
			rank: 0,
		},
	});

	if (!distribution.success) {
		throw new Error(`Distribution failed: ${JSON.stringify(distribution.errors)}`);
	}

	console.log(`✓ Opened ${openPlan.deliveredPacks} booster pack(s) for ${claim.owner}`);
	return distribution;
}
```

---

## Trading: List & Buy

Player lists a card; another buys it with royalty enforcement:

```typescript
import { buildList, buildBuy, createIndexerClient } from "nftlox-sdk";

const indexer = createIndexerClient("https://api-nftlox.hivecreators.co");

// Alice lists her Kael for 25 HIVE
const listing = await buildList({
	signer: "alice",
	nftId: "nft_hero_001_abc123", // instance she received from pack opening
	price: { amount: "25", currency: "HIVE" },
	memo: "Legendary warrior - undefeated deck hero",
});

console.log(`✓ Listed Kael for 25 HIVE`);

// Bob queries payment split
const payment = await indexer.getPaymentInfo("nft_hero_001_abc123");
console.log(`Seller: ${payment.seller}, Royalty: ${payment.royalty}`);
// Output: Seller: 23.75 HIVE, Royalty: 1.25 HIVE (5% royalty)

// Bob buys
const buy = await buildBuy({
	buyer: "bob",
	nftId: "nft_hero_001_abc123",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
});

console.log(`✓ Buy transaction ready for multisig signing`);
```

---

## Seasonal Updates: Reset Stats

Each season, update card stats and reset win/loss counts:

```typescript
import { buildDataOperatorApprove, buildSetDataFrom } from "nftlox-sdk";

// One-time: Approve game server as data operator
const approval = await buildDataOperatorApprove({
	creator: "card-game-admin",
	collectionId: collectionPlan.collectionId,
	operator: "card-game-season-service",
	approved: true,
});

// Season 2 starts: game server resets all cards
async function resetCardStatsForNewSeason(nftIds, newSeasonNumber) {
	const updates = await Promise.all(
		nftIds.map((nftId) =>
			buildSetDataFrom({
				operator: "card-game-season-service",
				nftId,
				instanceDna: "abc123def456", // from ownership proof
				mutableData: {
					wins: 0,
					losses: 0,
					deck_season: newSeasonNumber,
					rank: 0, // reset to bronze
				},
			}),
		),
	);

	console.log(`✓ Reset ${updates.length} cards for Season ${newSeasonNumber}`);
	return updates;
}
```

---

## Tournament: Lending & Prizes

Players lend cards to tournament winners temporarily:

```typescript
import { buildNftLend, buildNftReturn } from "nftlox-sdk";

// Tournament organizer lends promo card to winner for 1 month
const prizeCard = await buildNftLend({
	signer: "tournament-org",
	nftId: "nft_promo_legendary_card",
	borrower: "tournament-winner",
	durationDays: 30,
});

console.log(`✓ Lent promo card to ${tournament-winner} for 30 days`);

// After 30 days, winner returns it
const returnCard = await buildNftReturn({
	signer: "tournament-winner",
	nftId: "nft_promo_legendary_card",
});

console.log(`✓ Returned promo card to tournament-org`);
```

---

## Full Backend Flow with hive-tx

```typescript
import * as HiveTx from "@hiveio/wax";
import {
	buildCollectionWithSeeds,
	buildBulkDistribute,
	createIndexerClient,
	requestCreateCollectionMultisig,
} from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";
const indexer = createIndexerClient(INDEXER_URL);
const nodeAccount = await indexer.getMultisigNodeAccount();
console.log(`Node co-signer: ${nodeAccount}`);

const client = HiveTx.createClient("https://api.hive.blog");
const creatorKey = process.env.CREATOR_ACTIVE_KEY;
const posterKey = process.env.GAME_POSTING_KEY;

// 1. Create collection + 50 seeds
const plan = await buildCollectionWithSeeds(
	{
		creator: "card-game-admin",
		name: "Mythic Heroes",
		// ... schema and seeds defined above
		seeds: heroSeeds,
	},
	{ indexerBaseUrl: INDEXER_URL, feeCurrency: "HBD", feeAmount: "0.100" },
);

if (!plan.success) {
	throw new Error(`Collection plan failed: ${JSON.stringify(plan.errors)}`);
}

// 2. Sign & broadcast collection (active key + multisig)
const collectionTx = HiveTx.createHiveChain()
	.addOperation(...plan.collectionStep.operations)
	.addTaPoS()
	.addExpiration(30);

const signedTx = collectionTx
	.sign(HiveTx.createPrivateKeyManager([creatorKey]))
	.finalize();

const multisig = await requestCreateCollectionMultisig(INDEXER_URL, {
	transaction: signedTx,
});
if (!multisig.ok) {
	throw new Error(`Node multisig failed: ${multisig.message}`);
}

const finalCollectionTx = HiveTx.updateSignature(signedTx, multisig.signature);
await client.broadcast.sendChainTransaction(finalCollectionTx);

console.log(`✓ Collection created: ${plan.collectionId}`);

// 3. Broadcast seed batches (posting key)
for (const batch of plan.seedBatches) {
	const tx = HiveTx.createHiveChain()
		.addOperation(...batch.operations)
		.addTaPoS()
		.addExpiration(30)
		.sign(HiveTx.createPrivateKeyManager([posterKey]))
		.finalize();

	await client.broadcast.sendChainTransaction(tx);
	await new Promise((r) => setTimeout(r, 3000));
}

console.log("✓ All 50 hero seeds created and ready for distribution!");
```

---

## Database State

After this flow, your game database might track:

```sql
-- Players
| username | joined_date | rank | season_wins |
|----------|-------------|------|-------------|
| alice    | 2024-01-15  | 8    | 42          |
| bob      | 2024-02-01  | 5    | 18          |

-- Player NFT Inventory (synced from indexer)
| player   | nft_id                    | card_number | deck_season | wins | losses |
|----------|---------------------------|-------------|-------------|------|--------|
| alice    | nft_hero_001_abc123       | 1           | 2           | 23   | 5      |
| alice    | nft_hero_015_def456       | 15          | 2           | 15   | 12     |
| bob      | nft_hero_032_ghi789       | 32          | 2           | 7    | 14     |

-- Marketplace Listings (cached from indexer)
| nft_id              | seller | price | listed_at |
|---------------------|--------|-------|-----------|
| nft_hero_001_abc123 | alice  | 25    | 2024-03-10|
```

---

## Key Takeaways

- **buildCollectionWithSeeds:** One call creates 50 cards + automatic batching.
- **Deterministic IDs:** Card IDs are pre-computed; you can reference them in game logic before broadcasting.
- **Mutable data:** Player stats (wins, rank, season) live on-chain; game server updates via `set_data_from`.
- **Marketplace:** Built-in royalty enforcement; Alice's sales always give treasury 5%.
- **No smart contracts:** Just `custom_json` on Hive L1. Indexer validates; your game queries it.
- **Zero gas fees:** Hive resource credits are free for end users; you pay for operations.
- **Trustless:** Players can verify card ownership via SPV without trusting your backend.

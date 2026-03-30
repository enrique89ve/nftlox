# Packs and Distribution: Native vs Custom

Two paths to distribute NFTs to players. Choose based on your game.

---

## Quick Comparison

| | **Native Pack** | **Custom (bulk_distribute)** |
|---|---|---|
| **Flow** | Creator creates pack → Player buys → Player opens → RNG decides | Server resolves logic → Server distributes directly |
| **RNG** | On-chain, deterministic (SHA-256), resolved at open time | Your logic: local RNG, business rules, or whatever you want |
| **Payment** | Built-in: price per pack, 100% to creator | Your responsibility: detect payment off-protocol |
| **Drop table** | Max 50 seeds, weights 1-1,000,000 | No limit: 2,134 seeds or more |
| **Items per pack** | Max 20 | Max 50 distinct seeds per operation (each with quantity > 1) |
| **Mutable data** | Not supported at open time (instances born empty) | Supported: all instances inherit mutableData |
| **Supply exhaustion** | Individual pack skipped, others continue | Entire operation fails |
| **Key required** | Posting (create, open), Active (buy, transfer) | Posting (bulk_distribute) |
| **Ideal use case** | Loot boxes, mystery packs, surprise drops | Airdrops, rewards, distribution with game logic |

---

## Native Pack: On-Chain Loot Box

### Complete Flow

```
1. Creator defines pack
   pack_create { dropTable, itemsPerPack, price, maxSupply }
                                          |
2. Player buys packs
   pack_buy { packId, quantity }  ->  pays HIVE/HBD to creator
                                          |
3. Player opens packs
   pack_open { packId, quantity } ->  on-chain RNG selects seeds
                                          |
4. Instances created automatically
   Each pack item = new instance assigned to player
```

### When to Use

- You want the **protocol to handle payments** (fixed price per pack)
- Drop table of **50 seeds or fewer** (small card games, collectibles)
- You want **real suspense**: the player doesn't know what they get until they open
- You want **resellable packs**: buyers can transfer unopened packs to others

### Example: Card Game with 30 Creatures

```typescript
import {
  createPackCreatePayload,
  toHiveOperation,
} from "nftlox-sdk";

const packPayload = await createPackCreatePayload({
  collectionId: "col_monsters",
  name: "Monster Pack",
  description: "5 random monsters",
  imageUrl: "https://game.com/pack.png",
  itemsPerPack: 5,
  maxSupply: 10000,
  price: { amount: "2.000", currency: "HIVE" },
  dropTable: [
    // 30 creatures with rarity weights
    { seedId: "seed_dragon",   weight: 1 },     // legendary: 0.1%
    { seedId: "seed_phoenix",  weight: 5 },     // epic: 0.5%
    { seedId: "seed_golem",    weight: 20 },    // rare: 2%
    { seedId: "seed_wolf",     weight: 100 },   // common: 10%
    { seedId: "seed_slime",    weight: 200 },   // very common: 20%
    // ... up to 50 entries
  ],
}, "game-creator");

const operation = toHiveOperation(packPayload, "game-creator");
// Broadcast with posting key
```

### Native Pack Limitations

- **Max 50 seeds** in drop table -- won't work for 2,134 cards
- **Max 20 items** per pack
- **No mutableData** at open time -- instances are born without game data
- **No custom logic** -- you can't guarantee "at least 1 rare per pack"
- **Fixed pricing** -- no discounts, bundles, or in-game currency

---

## Custom Distribution: Your Logic, Your Control

### Complete Flow

```
1. Creator mints seeds (no quantity limit)
   mint { seedId, maxSupply, immutableData }
                                          |
2. Player pays (your logic)
   Hive transfer, in-game currency, quest reward, whatever you want
                                          |
3. Your server resolves what to distribute
   resolveDropTable() with 2,134+ entries, or your own logic
                                          |
4. Server calls bulk_distribute
   bulk_distribute { to: player, items: [{ seedId, quantity }] }
                                          |
5. Instances created with mutableData included
   Each instance is born with game data (level: 1, xp: 0)
```

### When to Use

- You have **more than 50 seeds** (large games)
- You want **mutableData** from the start
- You need **business logic** in selection (pity timer, seasonal rotation, rarity guarantees)
- Payment is **off-protocol** (in-game currency, quest rewards, free drops)
- You want **deterministic, verifiable** distribution

### Example: Ragnarok with 2,134 Cards and Pity Timer

```typescript
import {
  createBulkDistributePayload,
  resolveDropTable,
} from "nftlox-sdk";

// Your full drop table -- no 50-entry limit
const fullDropTable = cards.map(card => ({
  seedId: seedMap.get(card.artId)!,
  weight: RARITY_WEIGHTS[card.rarity],
}));

// Your game logic: pity timer guarantees 1 epic every 10 packs
function resolveWithPityTimer(
  player: string,
  packsSinceLastEpic: number,
  rngSeed: string,
): string[] {
  const resolved = resolveDropTable(fullDropTable, 5, rngSeed);

  // If 9 packs without an epic, force one
  if (packsSinceLastEpic >= 9) {
    const epics = fullDropTable.filter(e => e.weight <= 5);
    const forcedEpic = epics[Math.floor(Math.random() * epics.length)];
    resolved[4] = forcedEpic.seedId; // replace last slot
  }

  return resolved;
}

// Detect player payment
async function handlePlayerPayment(
  player: string,
  paymentTxId: string,
  paymentBlock: number,
): Promise<void> {
  const rngSeed = `${paymentTxId}:${paymentBlock}:${player}`;
  const pity = await getPlayerPityCounter(player);

  const resolvedSeeds = resolveWithPityTimer(player, pity, rngSeed);

  // Aggregate: {seedId, quantity, originBlock}
  const counts = new Map<string, number>();
  for (const seedId of resolvedSeeds) {
    counts.set(seedId, (counts.get(seedId) ?? 0) + 1);
  }

  const items = [...counts.entries()].map(([seedId, quantity]) => ({
    seedId,
    quantity,
    originBlock: paymentBlock,
  }));

  const payload = createBulkDistributePayload({
    to: player,
    items,
  });

  // Broadcast with seed owner's posting key
  const operation = ["custom_json", {
    required_auths: [],
    required_posting_auths: [SEED_OWNER],
    id: "nftlox_testnet",
    json: JSON.stringify(payload),
  }];

  await broadcastWithRetry(operation);
  await updatePityCounter(player, resolvedSeeds);
}
```

### Custom Distribution Patterns

#### Mass Airdrop

```typescript
// Distribute 1 instance of a seed to 100 players
for (const player of players) {
  const payload = createBulkDistributePayload({
    to: player,
    items: [{ seedId: "seed_promo", quantity: 1, originBlock: currentBlock }],
  });
  // broadcast...
}
```

#### Quest Reward

```typescript
// Player completed a quest -- receives 3 specific cards
const payload = createBulkDistributePayload({
  to: player,
  items: [
    { seedId: "seed_quest_sword",  quantity: 1, originBlock: block },
    { seedId: "seed_quest_shield", quantity: 1, originBlock: block },
    { seedId: "seed_quest_potion", quantity: 1, originBlock: block },
  ],
});
```

#### Seasonal Rotation

```typescript
// Only distribute cards from the current season
const seasonTable = fullDropTable.filter(entry => {
  const card = cardsBySeed.get(entry.seedId);
  return card?.season === currentSeason;
});
const resolved = resolveDropTable(seasonTable, 5, rngSeed);
```

#### Discounted Bundle (10 Packs for the Price of 8)

```typescript
// Server detects payment for 8 packs but resolves 10
async function handleBundlePurchase(player: string, txId: string, block: number) {
  const PACKS_IN_BUNDLE = 10;

  for (let i = 0; i < PACKS_IN_BUNDLE; i++) {
    const rngSeed = `${txId}:${block}:${player}:${i}`;
    const resolved = resolveDropTable(fullDropTable, 5, rngSeed);
    // aggregate and broadcast...
  }
}
```

---

## Decision Tree: Which One to Choose

```
Do you have more than 50 NFT types?
  Yes -> bulk_distribute (no drop table limit)
  No  |
      v
Do you need custom logic? (pity timer, seasonal, quests)
  Yes -> bulk_distribute (your server, your rules)
  No  |
      v
Do you want the protocol to handle payments?
  Yes -> Native pack (built-in pricing, creator receives 100%)
  No  |
      v
Do you want resellable unopened packs?
  Yes -> Native pack (pack_transfer + pack_open)
  No  -> bulk_distribute (simpler, fewer steps)
```

### Hybrid: Use Both Together

Nothing prevents using both in the same game:

- **Native packs** for seasonal drops (30 cards, loot box with fixed price)
- **bulk_distribute** for quest rewards, airdrops, and special events

Both create instances of the same type -- an NFT distributed via native pack and one via bulk_distribute are identical on-chain.

---

## Verification

Both systems are verifiable:

| | Native Pack | bulk_distribute |
|---|---|---|
| **Reproducible RNG** | Yes: `resolveDropTable(dropTable, itemsPerPack, rngSeed)` | Depends on your logic |
| **Deterministic instance IDs** | Yes: `generateDeterministicInstanceId(seedId, instanceNumber)` | Identical |
| **Deterministic DNA** | Yes: `generateDeterministicInstanceDna(seedId, instanceNumber, txId, blockNum)` | Identical |
| **On-chain auditable** | Yes: txId + blockNum are public | Yes: same mechanism |

For bulk_distribute with custom RNG, publish your drop table and rngSeed format. Anyone can re-derive the results with the SDK:

```typescript
import { resolveDropTable } from "nftlox-sdk";

// Verify the server didn't cheat
const rngSeed = `${txId}:${blockNum}:${player}`;
const expected = resolveDropTable(publishedDropTable, 5, rngSeed);
// Compare expected vs actual player NFTs
```

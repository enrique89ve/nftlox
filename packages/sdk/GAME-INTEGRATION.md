# NFTLox Game Integration Guide

Use the SDK for core NFT ownership, seed minting, instance distribution, mutable data updates, marketplace flows, lending, and SPV verification.

For general protocol operations, see [OPERATIONS.md](./OPERATIONS.md). For SDK setup and overview, see [README.md](./README.md).

---

## Recommended Flow

```
Create collection
  -> Mint seed templates
  -> Distribute instances with bulk_distribute
  -> Update mutable stats with set_data or set_data_from
  -> Verify ownership and operation anchors with SPV
```

## 1. Create a Typed Collection

Define the fields that your game needs before minting seeds. Immutable fields are copied into each distributed instance, while mutable fields can be updated later.

```typescript
import { buildCollection } from "nftlox-sdk";

const collection = await buildCollection({
	name: "Ragnarok Cards",
	symbol: "RGNRK",
	creator: "ragnarok-admin",
	totalPotential: 2134,
	metadata: {
		description: "Norse mythos card game",
		image: "https://example.com/collection.webp",
	},
	rules: {
		transferable: true,
		burnable: true,
		royaltyPct: 0,
	},
	schema: {
		immutable: [
			{ name: "card_id", type: "uint32" },
			{ name: "rarity", type: "string" },
			{ name: "attack", type: "uint16" },
			{ name: "health", type: "uint16" },
		],
		mutable: [
			{ name: "level", type: "uint8" },
			{ name: "xp", type: "uint32" },
		],
	},
});
```

## 2. Mint Seed Templates

A seed is the master NFT for a card, item, character, or other game asset. Instances distributed from a seed inherit its immutable data.

```typescript
import { buildSeed } from "nftlox-sdk";

const seed = await buildSeed({
	artId: "odin-001",
	collectionId: "col_abc123",
	signer: "ragnarok-admin",
	owner: "ragnarok-admin",
	edition: 1,
	name: "Echo of the Allfather",
	imageUrl: "https://example.com/cards/odin-001.webp",
	maxSupply: 250,
	immutableData: {
		card_id: 20001,
		rarity: "mythic",
		attack: 7,
		health: 7,
	},
});
```

## 3. Distribute Instances

Use `bulk_distribute` when a player earns, receives, or purchases game assets. Aggregate duplicate seed IDs before building the operation.

```typescript
import { buildBulkDistribute } from "nftlox-sdk";

const distribution = buildBulkDistribute({
	signer: "ragnarok-admin",
	to: "player123",
	items: [
		{ seedId: "seed_odin", quantity: 1, seedTxId: "a".repeat(40) },
		{ seedId: "seed_thor", quantity: 2, seedTxId: "b".repeat(40) },
	],
	mutableData: {
		level: 1,
		xp: 0,
	},
});
```

## 4. Update Game State

Use `set_data` when the collection creator writes mutable data. Use `set_data_from` after approving a game server as a data operator.

```typescript
import { buildDataOperatorApprove, buildSetDataFrom } from "nftlox-sdk";

const approval = buildDataOperatorApprove({
	collectionId: "col_abc123",
	creator: "ragnarok-admin",
	operator: "ragnarok-server",
	approved: true,
});

const update = buildSetDataFrom({
	nftId: "nft_abc123",
	instanceDna: "A3F7B2C119D0E4",
	operator: "ragnarok-server",
	mutableData: {
		level: 5,
		xp: 12500,
	},
});
```

## 5. Verify Ownership

The SPV module lets a client verify the current owner claim against Hive L1 without trusting the indexer response.

```typescript
import { createDefaultL1Config, verifyNftOwnership } from "nftlox-sdk";

const ownership = await verifyNftOwnership({
	nftId: "nft_abc123",
	expectedOwner: "player123",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config: createDefaultL1Config(),
});

if (ownership.status !== "verified") {
	throw new Error(ownership.message);
}
```

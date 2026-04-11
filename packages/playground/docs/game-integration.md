# Game Integration

Build game assets with typed collections, seed templates, instance distribution, mutable stats, lending, marketplace support, and SPV ownership checks.

For protocol operations, see [OPERATIONS.md](../../packages/sdk/OPERATIONS.md). For permissions, see [Key Security](key-security.md). For broadcasting, see [Broadcasting](broadcasting.md).

---

## Flow

```
Create a typed collection
  -> Mint seed templates
  -> Distribute instances with bulk_distribute
  -> Update mutable stats with set_data or set_data_from
  -> Verify ownership against Hive L1
```

## Collection Setup

Use collection schemas to separate permanent attributes from mutable game state.

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

## Seed Minting

Mint one seed per unique asset. Instances distributed from that seed inherit the immutable data.

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

## Instance Distribution

Use `bulk_distribute` to create playable instances for a user. Aggregate duplicate seed IDs before building the operation.

```typescript
import { buildBulkDistribute } from "nftlox-sdk";

const result = buildBulkDistribute({
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

## Data Operators

Approve a game server account when mutable stats should be updated by a service account instead of the collection creator.

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

## Ownership Verification

SPV ownership verification resolves `owner_operation_id` from Hive L1 and compares the derived owner with the indexer claim.

```typescript
import { createDefaultL1Config, verifyNftOwnership } from "nftlox-sdk";

const verification = await verifyNftOwnership({
	nftId: "nft_abc123",
	expectedOwner: "player123",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config: createDefaultL1Config(),
});

if (verification.status !== "verified") {
	throw new Error(verification.message);
}
```

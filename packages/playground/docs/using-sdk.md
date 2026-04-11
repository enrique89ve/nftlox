# Using the NFTLox SDK Directly

The playground API (`/api/build/*`) is a thin wrapper over the NFTLox SDK. If you want more control -- skip the HTTP layer and build payloads directly in your TypeScript/JavaScript code.

---

## When to use the SDK vs the API

| Use case | Recommended |
|----------|-------------|
| Quick testing, prototyping | API (`curl`, `fetch`) |
| Browser app with Hive Keychain | API (build payload, pass to Keychain) |
| Backend script (seed ceremony, airdrops) | **SDK** (direct, no HTTP overhead) |
| Game server (pack opening, bulk distribute) | **SDK** (full control over RNG + broadcast) |
| Custom tooling, CI/CD | **SDK** |

---

## Install

```bash
npm install nftlox-sdk
# or
bun add nftlox-sdk
```

The SDK is a pure TypeScript library with zero runtime dependencies (only Zod for validation). Works in Bun, Node.js, and browsers.

---

## Core Concepts

The SDK provides three layers:

1. **Payload creators** -- low-level functions that return protocol payloads
2. **Operation creators** -- wrap payloads into Hive `custom_json` operations (ready to sign)
3. **Builders** -- high-level functions with Zod validation, deterministic IDs, and warnings

```
Builder (validates + generates IDs)
  └── Payload creator (builds protocol JSON)
       └── Operation creator (wraps in Hive custom_json)
```

For most use cases, use the **builders** -- they validate input and generate deterministic IDs automatically.

---

## Create a Collection

```typescript
import { buildCollection } from "nftlox-sdk";

const result = buildCollection({
	name: "Ragnarok Cards",
	symbol: "RGNRK",
	creator: "ragnarok-admin",
	totalPotential: 2134,
	metadata: {
		description: "Norse Mythos Card Game",
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
			{ name: "name", type: "string" },
			{ name: "rarity", type: "string" },
			{ name: "attack", type: "uint16" },
			{ name: "health", type: "uint16" },
			{ name: "mana_cost", type: "uint8" },
		],
		mutable: [
			{ name: "level", type: "uint8" },
			{ name: "xp", type: "uint32" },
			{ name: "foil", type: "string" },
		],
	},
});

if (!result.success) {
	console.error("Validation failed:", result.errors);
	process.exit(1);
}

// result.generatedId  -- deterministic collection ID
// result.payload      -- protocol payload
// result.operation    -- ready-to-sign Hive operation
console.log("Collection ID:", result.generatedId);
```

---

## Mint Seeds

### Single seed

```typescript
import { buildSeed } from "nftlox-sdk";

const result = buildSeed({
	artId: "odin-001",
	collectionId: "col_abc123",
	signer: "ragnarok-admin",   // collection creator (signs the operation)
	owner: "ragnarok-admin",    // optional, defaults to signer. Can be a different account
	edition: 1,
	name: "Echo of the Allfather",
	imageUrl: "https://example.com/art/odin-001.webp",
	maxSupply: 250,
});

// result.generatedId -- deterministic seed ID (same artId + collectionId = same ID)
// result.operation   -- ready-to-sign Hive operation (signed by signer, not owner)
```

### With immutableData (typed schema)

```typescript
import { createDeterministicMintPayload } from "nftlox-sdk";

const payload = createDeterministicMintPayload({
	artId: "odin-001",
	collectionId: "col_abc123",
	collectionOriginDna: "A1B2C3D4E5F6G7H8",
	edition: 1,
	owner: "ragnarok-admin",
	name: "Echo of the Allfather",
	imageUrl: "https://example.com/art/odin-001.webp",
	maxSupply: 250,
	immutableData: {
		card_id: 20001,
		name: "Echo of the Allfather",
		rarity: "mythic",
		attack: 7,
		health: 7,
		mana_cost: 8,
	},
});

// payload.data.id -- deterministic seed ID
```

### Batch seeds

```typescript
import { buildSeedBatch } from "nftlox-sdk";

const result = buildSeedBatch({
	collectionId: "col_abc123",
	signer: "ragnarok-admin",   // collection creator
	seeds: [
		{ artId: "odin-001", name: "Echo of the Allfather", imageUrl: "https://...", maxSupply: 250 },
		{ artId: "thor-001", name: "Thunder Strike", imageUrl: "https://...", maxSupply: 500 },
		{ artId: "loki-001", name: "Trickster's Gambit", imageUrl: "https://...", maxSupply: 1000 },
	],
});

if (result.success) {
	// result.generatedIds -- map of artId -> seedId
	// To broadcast, build individual seed operations and batch them:
	const seeds = [
		{ artId: "odin-001", name: "Echo of the Allfather", imageUrl: "https://...", maxSupply: 250 },
		{ artId: "thor-001", name: "Thunder Strike", imageUrl: "https://...", maxSupply: 500 },
		{ artId: "loki-001", name: "Trickster's Gambit", imageUrl: "https://...", maxSupply: 1000 },
	];

	const operations = seeds.map((seed, i) => {
		const seedResult = buildSeed({
			...seed,
			collectionId: "col_abc123",
			signer: "ragnarok-admin",
			edition: i + 1,
		});
		return seedResult.operation;
	});

	// Hive limits to 5 operations per transaction
	for (let i = 0; i < operations.length; i += 5) {
		const batch = operations.slice(i, i + 5);
		await signAndBroadcast(batch);
		await delay(4000); // wait for block confirmation
	}
}
```

---

## Bulk Distribute (Create Instances)

```typescript
import { buildBulkDistribute } from "nftlox-sdk";

const result = buildBulkDistribute({
	signer: "ragnarok-admin",
	to: "player123",
	items: [
		{ seedId: "seed_xxx1", quantity: 1, seedTxId: "abc123...def456" },
		{ seedId: "seed_xxx2", quantity: 1, seedTxId: "abc123...def789" },
		{ seedId: "seed_xxx3", quantity: 1, seedTxId: "abc123...def012" },
	],
	mutableData: {
		level: 1,
		xp: 0,
		foil: "normal",
	},
});

// result.operation -- ready-to-sign Hive operation
```

---

## Pack Opening with RNG (Server-Side Resolution)

Use the SDK's deterministic RNG locally, then bulk_distribute the resolved cards:

```typescript
import {
	resolveDropTable,
	createBulkDistributePayload,
	generateDeterministicSeedId,
} from "nftlox-sdk";

// 1. Build drop table from your full card catalog (no 50-entry limit)
const dropTable = cards.map((card) => ({
	seedId: generateDeterministicSeedId(COLLECTION_ID, card.artId),
	weight: RARITY_WEIGHTS[card.rarity],
}));

// 2. Resolve using immutable blockchain data as RNG seed
const rngSeed = `${playerPaymentTxId}:${blockNum}:${playerAccount}`;
const selectedSeeds = resolveDropTable(dropTable, 5, rngSeed);

// 3. Aggregate (same seed can appear multiple times)
const seedCounts = new Map<string, number>();
for (const seedId of selectedSeeds) {
	seedCounts.set(seedId, (seedCounts.get(seedId) ?? 0) + 1);
}

// 4. Build bulk_distribute payload
const payload = createBulkDistributePayload({
	to: playerAccount,
	items: Array.from(seedCounts.entries()).map(([seedId, quantity]) => ({
		seedId,
		quantity,
		seedTxId: seedTxIds.get(seedId)!,
	})),
});

// 5. Sign and broadcast
```

---

## Update Mutable Data

### As collection creator

```typescript
import { buildSetData } from "nftlox-sdk";

const result = buildSetData({
	nftId: "nft_abc123_1_xyz",
	instanceDna: "A3F7B2C119D0E4",
	issuer: "ragnarok-admin",
	mutableData: {
		level: 5,
		xp: 12500,
		foil: "golden",
	},
});
```

### As data operator

If your game server is a different account than the collection creator:

```typescript
import { buildDataOperatorApprove, buildSetDataFrom } from "nftlox-sdk";

// 1. Creator approves game server as operator (one-time)
const approveResult = buildDataOperatorApprove({
	collectionId: "col_abc123",
	creator: "ragnarok-admin",
	operator: "ragnarok-gameserver",
	approved: true,
});

// 2. Game server updates data on any NFT in the collection
const updateResult = buildSetDataFrom({
	nftId: "nft_abc123_1_xyz",
	instanceDna: "A3F7B2C119D0E4",
	operator: "ragnarok-gameserver",
	mutableData: {
		level: 5,
		xp: 12500,
	},
});
```

---

## Transfer, Burn, List

```typescript
import { buildTransfer, buildBurn, buildList, buildUnlist } from "nftlox-sdk";

// Transfer
const transfer = buildTransfer({
	nftId: "nft_abc123_1_xyz",
	from: "alice",
	to: "bob",
});

// Burn
const burn = buildBurn({
	nftId: "nft_abc123_1_xyz",
	owner: "alice",
});

// List on marketplace
const list = buildList({
	nftId: "nft_abc123_1_xyz",
	owner: "alice",
	price: { amount: "10.000", currency: "HIVE" },
});

// Unlist
const unlist = buildUnlist({
	nftId: "nft_abc123_1_xyz",
	owner: "alice",
});
```

---

## Lending

```typescript
import { buildNftLend, buildNftReturn } from "nftlox-sdk";

// Lend to a player
const lend = buildNftLend({
	instanceId: "nft_abc123_1_xyz",
	borrower: "player123",
	owner: "ragnarok-admin",
});

// Return (either lender or borrower can call)
const returnNft = buildNftReturn({
	instanceId: "nft_abc123_1_xyz",
	signer: "player123",
});
```

---

## Allowances (Delegation)

```typescript
import {
	buildNftApprove,
	buildNftApproveAll,
	buildNftTransferFrom,
} from "nftlox-sdk";

// Approve a spender for one NFT
const approve = buildNftApprove({
	instanceId: "nft_abc123_1_xyz",
	spender: "marketplace-account",
	approved: true,
	owner: "alice",
});

// Approve for all NFTs in a collection
const approveAll = buildNftApproveAll({
	collectionId: "col_abc123",
	spender: "game-server",
	approved: true,
	owner: "alice",
});

// Transfer as approved spender
const transferFrom = buildNftTransferFrom({
	instanceId: "nft_abc123_1_xyz",
	from: "alice",
	to: "bob",
	spender: "game-server",
});
```

---

## DNA and ID Utilities

```typescript
import {
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicPackId,
	generateDeterministicInstanceId,
	generateOriginDna,
	resolveDropTable,
	deterministicRng,
	validateArtId,
	isSeedId,
	isInstanceId,
} from "nftlox-sdk";

// Deterministic IDs (same input = same output, always)
const collectionId = generateDeterministicCollectionId("ragnarok-admin", "Ragnarok Cards", "RGNRK");
const seedId = generateDeterministicSeedId(collectionId, "odin-001");
const packId = generateDeterministicPackId(collectionId, "Standard Pack");

// DNA
const originDna = await generateOriginDna(collectionId);

// RNG
const rng = deterministicRng("some-seed-string", 0); // returns float [0, 1)
const selected = resolveDropTable(dropTable, 5, "rng-seed");

// Validation
const artIdCheck = validateArtId("odin-001"); // { valid: true }
const isSeed = isSeedId("seed_abc123"); // true
const isInstance = isInstanceId("nft_abc123_1_xyz"); // true
```

---

## Signing and Broadcasting

The SDK builds payloads and operations. It does **not** sign or broadcast. Use any Hive library for that:

- [hive-tx](broadcasting.md#1-hive-tx-lightweight-used-by-nftlox-internally)
- [@hiveio/dhive](broadcasting.md#2-hiveiodhive-popular-well-documented)
- [@hiveio/wax](broadcasting.md#3-hiveiowax-official-hive-library-newest)

Every builder returns an `operation` field that is a ready-to-sign Hive operation:

```typescript
const result = buildSeed({ ... });
if (result.success) {
	const hiveOperation = result.operation;
	// Pass to hive-tx, dhive, or wax to sign and broadcast
}
```

---

## Full API Reference

For the complete list of exports, types, schemas, and constants, see the [SDK README](https://github.com/nftlox/nftlox/blob/master/packages/sdk/README.md).

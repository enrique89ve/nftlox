# Mutable Data Updates

This document shows how to update NFT mutable data (level up, XP gain, match results) using `set_data` and `set_data_from`.

---

## Overview

NFTLox collections with a typed schema can have **mutable fields** that change during gameplay. Only fields declared in the schema's `mutable` section can be updated.

| Operation | Who can use it | Key type |
|-----------|---------------|----------|
| `set_data` | Collection creator | Posting |
| `set_data_from` | Authorized data operator | Posting |

If your game server Hive account is the same as the collection creator, use `set_data`. If it is a separate account, authorize it as a data operator first, then use `set_data_from`.

---

## set_data: Creator Updates

The collection creator can update mutable data on any NFT in their collection.

### API Endpoint

`POST /api/build/set-data`

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

### Response

```json
{
	"success": true,
	"protocolVersion": "0.4.0",
	"operation": ["custom_json", { "..." }],
	"payload": { "..." },
	"keyType": "Posting"
}
```

Sign the `operation` with the creator's **posting key** and broadcast to Hive.

### SDK Usage

```typescript
import { createSetDataOperation, type SetDataInput } from "nftlox-sdk";

const input: SetDataInput = {
	nftId: "nft_a1b2c3d4_1_ef56",
	instanceDna: "A1B2C3D4E5F6G7",
	mutableData: {
		level: 5,
		xp: 2450,
		wins: 12,
		losses: 3,
	},
};

const operation = createSetDataOperation(input, "ragnarok-game");
// Sign with posting key and broadcast
```

---

## set_data_from: Operator Updates

If your game server uses a separate Hive account, you must first authorize it as a data operator.

### Step 1: Authorize the Operator

The collection creator broadcasts this once:

`POST /api/build/data-operator-approve`

```json
{
	"creator": "ragnarok-game",
	"collectionId": "col_abc123def456",
	"operator": "ragnarok-server",
	"approved": true
}
```

### Step 2: Update Data as Operator

`POST /api/build/set-data-from`

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

### SDK Usage

```typescript
import {
	createSetDataFromOperation,
	type SetDataFromInput,
} from "nftlox-sdk";

const input: SetDataFromInput = {
	nftId: "nft_a1b2c3d4_1_ef56",
	instanceDna: "A1B2C3D4E5F6G7",
	mutableData: {
		level: 10,
		xp: 8500,
		wins: 42,
		losses: 11,
	},
};

const operation = createSetDataFromOperation(input, "ragnarok-server");
// Sign with ragnarok-server's posting key and broadcast
```

---

## Batch Updates

You can batch up to 5 mutable data operations per Hive transaction. This is useful after a match where multiple cards need updating.

### Example: Recording a Match Result

```typescript
import {
	createSetDataFromOperation,
	TX_DELAY_MS,
	MAX_OPERATIONS_PER_TX,
	PROTOCOL_ID,
	type SetDataFromInput,
} from "nftlox-sdk";
import hive from "hive-tx";

const GAME_SERVER = "ragnarok-server";
const POSTING_KEY = process.env.HIVE_POSTING_KEY!;

interface MatchResult {
	readonly winnerId: string;
	readonly winnerDna: string;
	readonly winnerCurrentXp: number;
	readonly winnerCurrentWins: number;
	readonly loserId: string;
	readonly loserDna: string;
	readonly loserCurrentXp: number;
	readonly loserCurrentLosses: number;
}

async function recordMatchResult(match: MatchResult): Promise<string> {
	const XP_WIN = 100;
	const XP_LOSS = 25;

	const updates: SetDataFromInput[] = [
		{
			nftId: match.winnerId,
			instanceDna: match.winnerDna,
			mutableData: {
				xp: match.winnerCurrentXp + XP_WIN,
				wins: match.winnerCurrentWins + 1,
			},
		},
		{
			nftId: match.loserId,
			instanceDna: match.loserDna,
			mutableData: {
				xp: match.loserCurrentXp + XP_LOSS,
				losses: match.loserCurrentLosses + 1,
			},
		},
	];

	const operations = updates.map((input) => {
		const op = createSetDataFromOperation(input, GAME_SERVER);
		return op;
	});

	const tx = new hive.Transaction();
	tx.create(operations);
	tx.sign(hive.PrivateKey.from(POSTING_KEY));
	const result = await tx.broadcast();

	if (result?.error) {
		throw new Error(`Broadcast failed: ${JSON.stringify(result.error)}`);
	}

	return result?.result?.tx_id ?? "unknown";
}
```

### Example: Level Up

```typescript
async function levelUpCard(
	nftId: string,
	instanceDna: string,
	currentLevel: number,
	currentXp: number,
): Promise<string> {
	const XP_PER_LEVEL = 500;
	const requiredXp = currentLevel * XP_PER_LEVEL;

	if (currentXp < requiredXp) {
		throw new Error(
			`Not enough XP: ${currentXp}/${requiredXp} required for level ${currentLevel + 1}`,
		);
	}

	const input: SetDataFromInput = {
		nftId,
		instanceDna,
		mutableData: {
			level: currentLevel + 1,
			xp: currentXp - requiredXp,
		},
	};

	const operation = createSetDataFromOperation(input, GAME_SERVER);

	const tx = new hive.Transaction();
	tx.create([operation]);
	tx.sign(hive.PrivateKey.from(POSTING_KEY));
	const result = await tx.broadcast();

	if (result?.error) {
		throw new Error(`Broadcast failed: ${JSON.stringify(result.error)}`);
	}

	return result?.result?.tx_id ?? "unknown";
}
```

---

## Querying Current Data

Before updating, read the current mutable data from the indexer API:

```typescript
const API_BASE = "https://api-nftlox.hivecreators.co";

async function getNftData(nftId: string): Promise<{
	mutableData: Record<string, unknown>;
	instanceDna: string;
}> {
	const response = await fetch(`${API_BASE}/api/nfts/${nftId}`);
	const data = await response.json();
	return {
		mutableData: data.mutable_data ?? {},
		instanceDna: data.instance_dna,
	};
}

// Usage: read current state, compute new values, then write
const current = await getNftData("nft_a1b2c3d4_1_ef56");
const newXp = (current.mutableData.xp as number ?? 0) + 100;
```

---

## Revoking Operator Access

The collection creator can revoke a data operator at any time:

`POST /api/build/data-operator-approve`

```json
{
	"creator": "ragnarok-game",
	"collectionId": "col_abc123def456",
	"operator": "ragnarok-server",
	"approved": false
}
```

After this operation is processed, `set_data_from` calls from `ragnarok-server` will be rejected by the indexer.

---

## Schema Versions and Mutable Data

Collections track a `schema_version` that increments with each `extend_schema` call. NFTs record the `schema_version` at the time they were minted (immutable). However, `set_data` always validates against the collection's **current** schema, not the NFT's birth schema.

This is correct because `extend_schema` is append-only -- version N contains all fields from version N-1 plus new ones. An NFT born under schema v1 can receive v2 fields via `set_data`. The NFT's `schema_version` stays at 1 (recording when it was born), but its `mutable_data` can include fields added in later versions.

### Example

1. Collection created with schema v1: mutable fields `level`, `xp`.
2. Creator calls `extend_schema` adding mutable field `wins` -- collection is now at schema v2.
3. An NFT minted under v1 can now receive `wins` via `set_data`, because the current schema (v2) includes it.
4. The NFT's `schema_version` remains 1.

To inspect the full schema history, use `GET /api/collections/:id/schema-history`.

---

## Important Notes

- **Key type:** Both `set_data` and `set_data_from` use the **posting key**.
- **Schema enforcement:** Only fields declared in the collection's **current** schema's `mutable` section can be updated. Attempting to set an undeclared field or an `immutable` field will be rejected.
- **Partial updates:** You only need to include the fields you want to change. Omitted fields retain their current values.
- **No schema, no updates:** If the collection was created without a schema, `set_data` and `set_data_from` will be rejected. The schema must exist (either at collection creation or via `extend_schema`).

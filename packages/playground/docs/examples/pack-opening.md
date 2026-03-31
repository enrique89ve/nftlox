# Pack Opening Flow

This example shows the complete game-managed pack opening flow: detecting a player's HIVE payment, resolving cards with deterministic RNG, distributing NFT instances, and verifying the result.

**Pattern:** Server-Side Resolution -- the game server runs the RNG locally against the full card catalog, then broadcasts `bulk_distribute` with the resolved seed IDs.

---

## Overview

```
Player                    Game Server                  Hive Blockchain
------                    -----------                  ---------------

1. Send HIVE payment  ────────────────────────────────>  transfer op
                                                             |
2.                     <── detect payment (txId, block) ─────┘
                            |
3.                     resolveDropTable(fullCatalog, 5, rngSeed)
                            |
4.                     build bulk_distribute payload
                            |
5.                     ────────────────────────────────>  bulk_distribute op
                                                             |
6. Receive 5 NFTs     <─────────────────────────────────────┘
```

---

## Prerequisites

This example assumes you have already:
1. Created a collection with a schema (see [Seed Ceremony](seed-ceremony.md))
2. Minted all seeds (card catalog is on-chain)
3. Built a drop table mapping seed IDs to rarity weights

---

## Full Script

```typescript
import {
	resolveDropTable,
	generateDeterministicSeedId,
	createBulkDistributePayload,
	PROTOCOL_ID,
	MAX_BULK_DISTRIBUTE_ITEMS,
} from "nftlox-sdk";
import hive from "hive-tx";

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const CREATOR = "ragnarok-game";
const POSTING_KEY = process.env.HIVE_POSTING_KEY!;
const COLLECTION_ID = "col_abc123def456"; // From seed ceremony
const CARDS_PER_PACK = 5;
const PACK_PRICE = "2.000";
const PACK_CURRENCY = "HIVE";
const HIVE_RPC = "https://api.hive.blog";

hive.config.set("uri", HIVE_RPC);

// ---------------------------------------------------------------
// Drop Table (built from card catalog)
// ---------------------------------------------------------------

const RARITY_WEIGHTS: Readonly<Record<string, number>> = {
	legendary: 1,
	epic: 5,
	rare: 20,
	common: 100,
};

interface CardEntry {
	readonly artId: string;
	readonly rarity: string;
}

// In production, load from your database or JSON file
const CARD_CATALOG: ReadonlyArray<CardEntry> = [
	{ artId: "odin-allfather", rarity: "legendary" },
	{ artId: "frost-giant", rarity: "common" },
	{ artId: "valkyrie-shield", rarity: "rare" },
	{ artId: "loki-trickster", rarity: "epic" },
	{ artId: "mjolnir", rarity: "epic" },
	// ... all 2,134 cards
];

const DROP_TABLE = CARD_CATALOG.map((card) => ({
	seedId: generateDeterministicSeedId(COLLECTION_ID, card.artId),
	weight: RARITY_WEIGHTS[card.rarity] ?? 100,
}));

// ---------------------------------------------------------------
// Step 1: Detect Player Payment
// ---------------------------------------------------------------

interface PaymentInfo {
	readonly txId: string;
	readonly blockNum: number;
	readonly sender: string;
	readonly amount: string;
	readonly currency: string;
	readonly memo: string;
}

/**
 * Poll the Hive blockchain for incoming transfers to the game account.
 * In production, use a streaming library (e.g., hive-stream) instead of polling.
 */
async function detectPayment(
	expectedSender: string,
	expectedMemo: string,
): Promise<PaymentInfo> {
	// Option A: Use Hive API to get account history
	const result = await fetch(HIVE_RPC, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "condenser_api.get_account_history",
			params: [CREATOR, -1, 100],
			id: 1,
		}),
	});

	const data = await result.json();
	const history = data.result;

	for (const [, entry] of history) {
		const op = entry.op;
		if (op[0] !== "transfer") continue;

		const transfer = op[1];
		if (
			transfer.from === expectedSender &&
			transfer.to === CREATOR &&
			transfer.memo === expectedMemo
		) {
			return {
				txId: entry.trx_id,
				blockNum: entry.block,
				sender: transfer.from,
				amount: transfer.amount.split(" ")[0],
				currency: transfer.amount.split(" ")[1],
				memo: transfer.memo,
			};
		}
	}

	throw new Error("Payment not found");
}

/**
 * Alternative: look up a specific transaction by ID.
 */
async function getTransactionInfo(txId: string): Promise<{
	blockNum: number;
	sender: string;
}> {
	const result = await fetch(HIVE_RPC, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "condenser_api.get_transaction",
			params: [txId],
			id: 1,
		}),
	});

	const data = await result.json();
	const tx = data.result;

	return {
		blockNum: tx.block_num,
		sender: tx.operations[0][1].from,
	};
}

// ---------------------------------------------------------------
// Step 2: Resolve Cards with Deterministic RNG
// ---------------------------------------------------------------

function buildRngSeed(
	txId: string,
	blockNum: number,
	player: string,
): string {
	return `${txId}:${blockNum}:${player}`;
}

function resolvePackCards(
	txId: string,
	blockNum: number,
	player: string,
): string[] {
	const rngSeed = buildRngSeed(txId, blockNum, player);
	return resolveDropTable(
		DROP_TABLE as Array<{ seedId: string; weight: number }>,
		CARDS_PER_PACK,
		rngSeed,
	);
}

// ---------------------------------------------------------------
// Step 3: Aggregate and Build bulk_distribute Payload
// ---------------------------------------------------------------

function aggregateSeeds(
	seedIds: ReadonlyArray<string>,
	seedTxId: string,
): Array<{ seedId: string; quantity: number; seedTxId: string }> {
	const counts = new Map<string, number>();
	for (const id of seedIds) {
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return Array.from(counts.entries()).map(([seedId, quantity]) => ({
		seedId,
		quantity,
		seedTxId,
	}));
}

// ---------------------------------------------------------------
// Step 4: Broadcast bulk_distribute
// ---------------------------------------------------------------

async function broadcastBulkDistribute(
	player: string,
	items: Array<{ seedId: string; quantity: number; seedTxId: string }>,
): Promise<string> {
	// Safety check: bulk_distribute supports up to 50 distinct seeds
	if (items.length > MAX_BULK_DISTRIBUTE_ITEMS) {
		throw new Error(
			`Too many distinct seeds (${items.length}). Max is ${MAX_BULK_DISTRIBUTE_ITEMS}.`,
		);
	}

	const payload = createBulkDistributePayload({
		to: player,
		items,
	});

	const operation: [string, Record<string, unknown>] = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [CREATOR],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

	const tx = new hive.Transaction();
	tx.create([operation]);
	tx.sign(hive.PrivateKey.from(POSTING_KEY));
	const result = await tx.broadcast();

	if (result?.error) {
		throw new Error(`Broadcast failed: ${JSON.stringify(result.error)}`);
	}

	return result?.result?.tx_id ?? "unknown";
}

// ---------------------------------------------------------------
// Step 5: Complete Pack Opening Flow
// ---------------------------------------------------------------

async function openPack(
	player: string,
	paymentTxId: string,
): Promise<{
	resolvedSeeds: string[];
	distributeTxId: string;
	rngSeed: string;
}> {
	// 5a. Get payment block number
	const txInfo = await getTransactionInfo(paymentTxId);
	const blockNum = txInfo.blockNum;

	// 5b. Build RNG seed from immutable blockchain data
	const rngSeed = buildRngSeed(paymentTxId, blockNum, player);
	console.log(`RNG seed: ${rngSeed}`);

	// 5c. Resolve cards
	const resolvedSeeds = resolvePackCards(paymentTxId, blockNum, player);
	console.log(`Resolved ${resolvedSeeds.length} cards:`, resolvedSeeds);

	// 5d. Aggregate (combine duplicates)
	const items = aggregateSeeds(resolvedSeeds, blockNum);
	console.log(`Aggregated into ${items.length} distinct seeds`);

	// 5e. Broadcast bulk_distribute
	const distributeTxId = await broadcastBulkDistribute(player, items);
	console.log(`Distributed: txId=${distributeTxId}`);

	return { resolvedSeeds, distributeTxId, rngSeed };
}

// ---------------------------------------------------------------
// Step 6: Verify the Result
// ---------------------------------------------------------------

function verifyPackOpening(
	paymentTxId: string,
	blockNum: number,
	player: string,
	expectedSeedIds: ReadonlyArray<string>,
): boolean {
	const rngSeed = buildRngSeed(paymentTxId, blockNum, player);
	const resolved = resolveDropTable(
		DROP_TABLE as Array<{ seedId: string; weight: number }>,
		CARDS_PER_PACK,
		rngSeed,
	);

	if (resolved.length !== expectedSeedIds.length) {
		console.error(
			`Length mismatch: got ${resolved.length}, expected ${expectedSeedIds.length}`,
		);
		return false;
	}

	for (let i = 0; i < resolved.length; i++) {
		if (resolved[i] !== expectedSeedIds[i]) {
			console.error(
				`Mismatch at index ${i}: got ${resolved[i]}, expected ${expectedSeedIds[i]}`,
			);
			return false;
		}
	}

	console.log("Verification passed: all cards match.");
	return true;
}

// ---------------------------------------------------------------
// Usage Example
// ---------------------------------------------------------------

async function main(): Promise<void> {
	const player = "player-alice";
	const paymentTxId = "abc123def456789012345678901234567890abcd";

	// Process the pack opening
	const result = await openPack(player, paymentTxId);

	// Anyone can verify later
	const txInfo = await getTransactionInfo(paymentTxId);
	const isValid = verifyPackOpening(
		paymentTxId,
		txInfo.blockNum,
		player,
		result.resolvedSeeds,
	);

	console.log(`Pack opening valid: ${isValid}`);
}

main().catch(console.error);
```

---

## Using the Playground API

If you prefer API calls over direct SDK usage, use the playground's build endpoint:

```typescript
// Step 1: Resolve cards locally (SDK function, no API needed)
const rngSeed = `${paymentTxId}:${blockNum}:${player}`;
const resolvedSeeds = resolveDropTable(dropTable, 5, rngSeed);

// Step 2: Aggregate seeds
const counts = new Map<string, number>();
for (const id of resolvedSeeds) {
	counts.set(id, (counts.get(id) ?? 0) + 1);
}
const items = Array.from(counts.entries()).map(([seedId, quantity]) => ({
	seedId,
	quantity,
	seedTxId: seedTxIds.get(seedId)!,
}));

// Step 3: Build the operation via playground API
const response = await fetch("https://nftloxtest.hivecreators.co/api/build/bulk-distribute", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		signer: "ragnarok-game",
		to: player,
		items,
	}),
});

const result = await response.json();
// result.operation contains the ready-to-sign Hive custom_json operation
// Sign with posting key and broadcast
```

---

## Verification: How It Works

The verification process is straightforward because all inputs are public:

1. **Drop table** -- published by the game (card catalog with rarity weights). This should be versioned and publicly accessible.
2. **Payment transaction** -- on-chain, provides `txId` and `blockNum`.
3. **Player username** -- on-chain (the `from` field of the transfer).
4. **RNG algorithm** -- specified in [RNG Reference](../rng-reference.md).

Given these four inputs, anyone can call `resolveDropTable()` and confirm the exact cards that should have been distributed. The algorithm is deterministic: same inputs always produce the same output.

### Third-Party Verification Script

```typescript
import { resolveDropTable, generateDeterministicSeedId } from "nftlox-sdk";

// Load the game's published drop table
const dropTable = publishedCardCatalog.map((card) => ({
	seedId: generateDeterministicSeedId(collectionId, card.artId),
	weight: rarityWeights[card.rarity],
}));

// Reconstruct RNG seed from blockchain data
const rngSeed = `${paymentTxId}:${blockNum}:${player}`;

// Resolve and compare
const expected = resolveDropTable(dropTable, cardsPerPack, rngSeed);
const actual = getDistributedSeedsFromChain(distributeTxId);

const match = expected.every((id, i) => id === actual[i]);
console.log(`Audit result: ${match ? "PASS" : "FAIL"}`);
```

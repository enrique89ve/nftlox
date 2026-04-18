# Seed Ceremony

End-to-end script: launch a brand-new collection with a schema, then mint every seed in the catalogue. Uses the real SDK and `hive-tx`. Run it with `bun run` or `node --loader tsx`.

A **seed ceremony** is the one-time onboarding ritual for a collection: the creator broadcasts the collection (paying the protocol fee, co-signed by the node) and then mints the full seed catalogue. After the ceremony, gameplay code only needs `bulk_distribute` to hand out instances.

## Prerequisites

- Hive account with **active + posting** keys exported via environment variables.
- `nftlox-sdk` and `hive-tx` installed.
- A testnet indexer URL (default: `https://api-nftlox.hivecreators.co`).

```bash
export HIVE_ACCOUNT=alice
export HIVE_ACTIVE_KEY=5…            # used once, for create_collection
export HIVE_POSTING_KEY=5…           # used per seed batch + per bulk_distribute
export INDEXER=https://api-nftlox.hivecreators.co
```

## The catalogue

Seeds are keyed by `artId` — a creator-chosen stable slug. It is the primary input to `generateDeterministicSeedId(collectionId, artId)`, so the same artId always produces the same seed id across machines.

```typescript
type Card = {
	readonly artId: string;           // sanitized slug; see validateArtId()
	readonly name: string;
	readonly imageUrl: string;
	readonly maxSupply: number;       // how many instances can be distributed
	readonly rarity: "common" | "rare" | "epic" | "legendary";
	readonly basePower: number;       // uint16
};

const CATALOGUE: readonly Card[] = [
	{ artId: "warrior",  name: "Warrior",  imageUrl: "https://…/warrior.png",  maxSupply: 1000, rarity: "common",    basePower: 50 },
	{ artId: "mage",     name: "Mage",     imageUrl: "https://…/mage.png",     maxSupply:  500, rarity: "rare",      basePower: 80 },
	{ artId: "dragon",   name: "Dragon",   imageUrl: "https://…/dragon.png",   maxSupply:   50, rarity: "legendary", basePower: 250 },
	// …
];
```

## The full script

```typescript
import {
	buildCollectionWithSeeds,
	createSchemaBuilder,
	createIndexerClient,
	requestCreateCollectionMultisig,
	MultisigError,
} from "nftlox-sdk";
import hive from "hive-tx";

const INDEXER = process.env.INDEXER!;
const HIVE_RPC = "https://api.hive.blog";
hive.config.set("node", HIVE_RPC);

const CREATOR = process.env.HIVE_ACCOUNT!;
const ACTIVE  = hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!);
const POSTING = hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!);
const client  = createIndexerClient(INDEXER);

async function broadcast(ops: readonly unknown[], key: hive.PrivateKey) {
	const tx = new hive.Transaction();
	await tx.create(ops as [string, object][]);
	tx.sign(key);
	const res = await tx.broadcast();
	if (res?.error) throw new Error(JSON.stringify(res.error));
	return res.result.tx_id as string;
}

async function waitForIndex(txId: string) {
	for (let i = 0; i < 15; i++) {
		const status = await client.getOperationStatus(txId);
		if (status.indexed && status.confirmed === status.totalOperations) return status;
		if (status.invalid > 0) throw new Error(`Invalid ops: ${JSON.stringify(status.operations)}`);
		await new Promise(r => setTimeout(r, 2000));
	}
	throw new Error(`Timed out waiting for tx_id=${txId}`);
}

async function ceremony() {
	// 1. Plan the whole ceremony in one call
	const plan = await buildCollectionWithSeeds({
		name: "Heroes of Ragnarok",
		symbol: "HERO",
		creator: CREATOR,
		totalPotential: CATALOGUE.reduce((n, c) => n + c.maxSupply, 0),
		metadata: {
			description: "Playable hero cards",
			image: "https://…/cover.png",
		},
		rules: { transferable: true, burnable: true, royaltyPct: 5 },
		schema: createSchemaBuilder()
			.immutable("rarity", "string")
			.immutable("base_power", "uint16")
			.mutable("xp", "uint32")
			.mutable("wins", "uint32")
			.build(),
		seeds: CATALOGUE.map(c => ({
			artId: c.artId,
			name: c.name,
			imageUrl: c.imageUrl,
			maxSupply: c.maxSupply,
			immutableData: { rarity: c.rarity, base_power: c.basePower },
		})),
	}, { indexerBaseUrl: INDEXER, requireMultisigReady: true });

	if (!plan.success) {
		console.error(plan.errors);
		process.exit(1);
	}
	console.log(`Plan ready: collection=${plan.collectionId}, ${plan.seedBatches.length} seed batches`);

	// 2. Broadcast the collection (dual-signer)
	const colTx = new hive.Transaction();
	await colTx.create(plan.collectionStep.operations as [string, object][]);

	const nodeSig = await requestCreateCollectionMultisig(INDEXER, {
		transaction: colTx.transaction,
	});
	if (!nodeSig.ok) {
		throw new MultisigError({ message: nodeSig.message, code: nodeSig.code, url: INDEXER });
	}
	colTx.transaction.signatures.push(nodeSig.signature);
	colTx.sign(ACTIVE);
	const colResult = await colTx.broadcast();
	if (colResult?.error) throw new Error(JSON.stringify(colResult.error));
	const colTxId = colResult.result.tx_id as string;
	console.log("Collection broadcast:", colTxId);
	await waitForIndex(colTxId);

	// 3. Broadcast each seed batch (posting-only)
	for (const batch of plan.seedBatches) {
		const txId = await broadcast(batch.operations, POSTING);
		console.log(`Batch ${batch.batchNumber}: ${batch.seeds.length} seeds → ${txId}`);
		await waitForIndex(txId);
		await new Promise(r => setTimeout(r, 4000));   // respects TX_DELAY_MS
	}

	console.log("Ceremony complete. Seed IDs:", plan.generatedIds);
}

ceremony().catch(err => {
	console.error(err);
	process.exit(1);
});
```

## Why `buildCollectionWithSeeds`?

- **Atomic planning.** One call validates every seed, rejects duplicate artIds, and pre-computes every `seed_<…>` id.
- **Right-sized batches.** The orchestrator measures the first seed's payload with `calculateMaxOperationsPerTx` and splits the catalogue so each Hive tx stays below 90% of the 8 KiB cap and under `MAX_OPERATIONS_PER_TX = 5`.
- **One-shot key model.** The active key is only exposed once (for the collection step). Every seed batch uses the posting key — loss of the posting key is recoverable; loss of the active key is not.

## Distributing instances after the ceremony

Once the seeds are indexed, `bulk_distribute` mints instances from any seed (up to its `maxSupply`). This is a posting-only action — no multisig, no fee.

```typescript
import { buildBulkDistribute } from "nftlox-sdk";

const r = buildBulkDistribute({
	signer: CREATOR,
	to: "playerOne",
	items: [
		{ seedId: plan.generatedIds["warrior"]!, quantity: 3, seedTxId: colTxId },
		{ seedId: plan.generatedIds["mage"]!,     quantity: 1, seedTxId: colTxId },
	],
});
if (!r.success) throw new Error(JSON.stringify(r.errors));
const distributeTxId = await broadcast(r.operations, POSTING);
console.log("Distributed:", distributeTxId);
```

The distribution can reference any tx_id in the seed's lineage — the indexer validates `seedTxId` against its internal provenance index.

## Idempotency & re-runs

Seed IDs are deterministic. Re-running the script with the same `(collectionId, artId)` pairs produces the same IDs; the indexer will reject duplicate seeds with `SEED_ALREADY_EXISTS`. To **resume** a partial ceremony, skip batches whose seeds are already indexed:

```typescript
const { nfts } = await client.getUserNfts(CREATOR, { type: "seed" });
const existing  = new Set(nfts.map(n => n.id));
const remaining = plan.seedBatches.filter(b => b.seeds.some(s => !existing.has(s.seedId)));
```

## See also

- [Mutable Data](mutable-data.md) — updating `mutableData` after instances are minted.
- [SDK Reference — `buildCollectionWithSeeds`](../sdk/reference.md#collections) — full option surface.
- [Signing & Broadcasting](../broadcasting.md) — the multisig merge step explained line by line.

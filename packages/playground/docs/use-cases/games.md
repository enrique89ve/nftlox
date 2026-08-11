# Game Development with NFTLox

Build games with on-chain NFTs that have functional DNA, mutable stats, and provable ownership — all without smart contracts, gas fees, or oracles.

---

## Architecture Overview

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
- Ownership edges verified client-side against Hive L1 anchors.

---

## Shared Setup

```typescript
import {
	buildCollectionWithSeeds,
	buildBulkDistribute,
	buildList,
	buildBuy,
	buildSetDataFrom,
	buildDataOperatorApprove,
	buildNftLend,
	buildNftReturn,
	createSchemaBuilder,
	createIndexerClient,
	requestCreateCollectionMultisig,
	MultisigError,
} from "nftlox-sdk";
import hive from "hive-tx";

const INDEXER = "https://api-nftlox.hivecreators.co";
hive.config.set("node", "https://api.hive.blog");

const client = createIndexerClient(INDEXER);
const CREATOR = "ragnarok-studio";
const SERVER  = "ragnarok-server";
const ACTIVE  = hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!);
const POSTING = hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!);
const SERVER_POSTING = hive.PrivateKey.from(process.env.SERVER_POSTING_KEY!);

async function broadcast(ops: readonly unknown[], key: hive.PrivateKey) {
	const tx = new hive.Transaction();
	await tx.create(ops as [string, object][]);
	tx.sign(key);
	const res = await tx.broadcast();
	if (res?.error) throw new Error(JSON.stringify(res.error));
	return res.result.tx_id as string;
}
```

---

## 1. Collection & Schema Design

Define your NFT types upfront with **typed schemas** — immutable stats (rarity, class) are locked forever; mutable stats (level, xp, wins) update throughout gameplay.

```typescript
const HEROES = [
	{ artId: "warrior", name: "Warrior", imageUrl: "https://…/warrior.png", maxSupply: 1000,
		immutableData: { rarity: "common",    base_power: 50 } },
	{ artId: "mage",    name: "Mage",    imageUrl: "https://…/mage.png",    maxSupply:  500,
		immutableData: { rarity: "rare",      base_power: 80 } },
	{ artId: "dragon",  name: "Dragon",  imageUrl: "https://…/dragon.png",  maxSupply:   50,
		immutableData: { rarity: "legendary", base_power: 250 } },
];

const plan = await buildCollectionWithSeeds({
	name: "Heroes of Ragnarok",
	symbol: "HERO",
	creator: CREATOR,
	totalPotential: HEROES.reduce((n, h) => n + h.maxSupply, 0),
	metadata: { description: "Playable hero cards", image: "https://…/cover.png" },
	rules: { transferable: true, burnable: true, royaltyPct: 5 },
	schema: createSchemaBuilder()
		.immutable("rarity", "string")
		.immutable("base_power", "uint16")
		.mutable("xp", "uint32")
		.mutable("level", "uint8")
		.mutable("wins", "uint32")
		.build(),
	seeds: HEROES,
}, { indexerBaseUrl: INDEXER, requireMultisigReady: true });

if (!plan.success) { console.error(plan.errors); process.exit(1); }
```

`buildCollectionWithSeeds` validates all seeds, pre-computes every `seed_<…>` ID, and splits them into batches that fit Hive's 8 KiB `custom_json` limit automatically.

---

## 2. Launch the Catalogue (Seed Ceremony)

The collection step requires the creator's **active key** + node co-signature. Seed batches only need the **posting key**.

```typescript
// Collection step — dual-signer: creator active + node multisig
const colTx = new hive.Transaction();
await colTx.create(plan.collectionStep.operations as [string, object][]);
const sig = await requestCreateCollectionMultisig(INDEXER, { transaction: colTx.transaction });
if (!sig.ok) throw new MultisigError({ message: sig.message, code: sig.code, url: INDEXER });
colTx.transaction.signatures.push(sig.signature);
colTx.sign(ACTIVE);
const colTxId = (await colTx.broadcast()).result.tx_id;
console.log(`Collection: ${plan.collectionId}`);

// Seed batches — posting-only
for (const batch of plan.seedBatches) {
	await broadcast(batch.operations, POSTING);
	await new Promise(r => setTimeout(r, 4000));   // respects TX_DELAY_MS
}

// Grant the game server permission to update mutable stats (one-time per collection)
const grant = buildDataOperatorApprove({
	creator: CREATOR,
	collectionId: plan.collectionId,
	operator: SERVER,
	approved: true,
});
if (grant.success) await broadcast(grant.operations, POSTING);
```

For the full script with indexer confirmation polling and idempotency handling, see [Seed Ceremony](seed-ceremony.md).

---

## 3. Instance Distribution — Pack Opening

When a player earns or opens a pack, distribute instances from seeds with `buildBulkDistribute`. The chain records exactly which instances went to whom.

```typescript
function rollPack(): { seedId: string; quantity: number }[] {
	const roll   = Math.random();
	const rare   = plan.generatedIds["mage"]!;
	const common = plan.generatedIds["warrior"]!;
	const legend = plan.generatedIds["dragon"]!;
	if (roll < 0.01) return [{ seedId: legend, quantity: 1 }, { seedId: common, quantity: 4 }];
	if (roll < 0.15) return [{ seedId: rare,   quantity: 1 }, { seedId: common, quantity: 4 }];
	return [{ seedId: common, quantity: 5 }];
}

async function openPack(player: string) {
	const items = rollPack().map(i => ({ ...i, seedTxId: colTxId }));
	const result = buildBulkDistribute({ signer: CREATOR, to: player, items });
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, POSTING);
}
```

Each instance gets a unique `nftDna` and `instanceNumber`. The player owns distinct NFTs that can be transferred, listed, or lent independently. Cap per call: `MAX_BULK_DISTRIBUTE_ITEMS = 50` seeds and `MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY = 250` instances.

---

## 4. Marketplace — List & Buy

Listings require the owner's **active key**. Buys require the buyer's **active key** + node co-signature. Always read the payment split from the indexer — never compute it yourself.

```typescript
// Player lists a card (active key, single-signer)
async function listCard(owner: string, nftId: string, priceHive: string) {
	const result = await buildList({
		owner,
		nftId,
		price: { amount: priceHive, currency: "HIVE" }, // 3-decimal string, e.g. "10.000"
		expiresAt: Date.now() + 7 * 24 * 3600 * 1000,  // 7 days
		marketplace: "ragnarok",                         // optional scope tag
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, ACTIVE);
}

// Another player buys it (active key + node multisig)
async function buyCard(buyer: string, nftId: string) {
	const payment = await client.getPaymentInfo(nftId);
	const result = buildBuy({
		buyer,
		seller: payment.seller,
		nftId: payment.nftId,
		listingId: payment.listingId,
		listTxId: payment.listTxId,
		txId: payment.txId,
		nodeAccount: payment.nodeAccount,
		paymentSplit: {
			sellerAmount: payment.sellerAmount,
			royaltyAmount: payment.royaltyAmount,
			royaltyRecipient: payment.royaltyRecipient,
			feeAmount: payment.feeAmount,
			feeAccount: payment.feeAccount,
			totalPrice: payment.totalPrice,
			currency: payment.currency as "HIVE" | "HBD",
		},
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));

	const tx = new hive.Transaction();
	await tx.create(result.operations as [string, object][]);
	const resp = await client.multisig({
		buyer, nftId, listingId: payment.listingId, listTxId: payment.listTxId,
		transaction: tx.transaction,
	});
	if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: INDEXER });
	tx.transaction.signatures.push(resp.signature);
	tx.sign(ACTIVE);   // in a browser, Keychain supplies this signature
	await tx.broadcast();
}
```

`getPaymentInfo` returns the exact split (seller net, royalty, protocol fee). Never recompute it — the node rejects any mismatch with `INVALID_PAYMENT_SPLIT`.

---

## 5. Mutable Stats — Server-Side Updates

The game server updates stats with its own posting key using `buildSetDataFrom`. No player key is ever exposed to the server.

```typescript
async function recordWin(nftId: string, xpEarned: number) {
	const nft   = await client.getNft(nftId);
	const wins  = (nft.mutable_data?.wins  as number ?? 0) + 1;
	const xp    = (nft.mutable_data?.xp    as number ?? 0) + xpEarned;
	const level = Math.min(100, Math.floor(xp / 1000) + 1);

	const result = buildSetDataFrom({
		operator: SERVER,
		nftId,
		nftDna: nft.nft_dna!,      // required — binds write to current NFT state
		mutableData: { xp, level, wins },
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, SERVER_POSTING);
}
```

**Shallow merge:** only the keys you send are overwritten. Omitted fields keep their current values.

Revoke the data operator approval any time by broadcasting `buildDataOperatorApprove` with `approved: false` — effective from the next block.

For the owner updating their own NFT, use `buildSetData` with `owner:` instead of `operator:`. See [Mutable Data](mutable-data.md) for a complete guide.

---

## 6. Lending — Tournament Rentals

Non-custodial lending: the lender keeps ownership, the borrower gets a scoped right of use. While lent, the card cannot be listed, transferred, or re-lent — but XP still accumulates.

```typescript
// Lender lends a card to a teammate (signed with lender's active key)
async function lend(owner: string, instanceId: string, borrower: string) {
	const result = buildNftLend({ owner, instanceId, borrower });
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, ACTIVE);
}

// Borrower returns it when done (signed with borrower's active key)
async function returnCard(borrower: string, instanceId: string) {
	const result = buildNftReturn({ owner: borrower, instanceId });
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, ACTIVE);
}
```

Only the current borrower can call `buildNftReturn`. The lender's rights are restored immediately — no cooldown. `LEND_TO_SELF` is rejected by the builder; lending an already-lent NFT is rejected by the indexer (`NFT_LOCKED`).

**Common patterns:**
- Guild banks: lend gear to new recruits with social trust.
- Paid rentals: borrower pays off-chain; your backend calls `buildNftReturn` at expiry.
- Tournament whitelist: lend a legendary card for the weekend; XP earned accrues to the owner.

---

## 7. Ownership Verification (SPV)

Let players verify the referenced ownership edge on their client against Hive L1.

```typescript
import { verifyNftOwnership, createDefaultL1Config } from "nftlox-sdk";

const proof = await verifyNftOwnership({
	nftId: "nft_hero_001",
	expectedOwner: "player-alice",
	indexerBaseUrl: INDEXER,
	l1Config: createDefaultL1Config(),
});

if (proof.status === "verified") {
	console.log(`Verified in ${proof.durationMs}ms`);
} else {
	console.error(`Verification failed: ${proof.message}`);
}
```

---

## Architecture Patterns

| Pattern | Use Case | Key Type | Builder |
|---|---|---|---|
| **Direct ownership** | Player gets item from pack | Posting | `buildBulkDistribute` |
| **Data operator** | Game server updates stats at scale | Posting | `buildSetDataFrom` |
| **Lending** | Guild bank, tournament rentals | Posting | `buildNftLend` / `buildNftReturn` |
| **Marketplace** | Player-to-player trading | Active (`buy`) + Posting | `buildList` / `buildBuy` |
| **Approval** | Delegate transfer to a contract | Posting | `buildNftApprove` |
| **SPV** | L1-anchored client-side check | None (client-side) | `verifyNftOwnership` |

---

## Next Steps

- [Seed Ceremony](seed-ceremony.md) — full launch script with confirmation polling and idempotency.
- [Mutable Data](mutable-data.md) — `set_data` for owners, `set_data_from` for game servers.
- [SDK Reference](../sdk/reference.md) — full builder table with input shapes.
- [Signing & Broadcasting](../broadcasting.md) — hive-tx / dhive / wax / Keychain patterns.
- [LLM Context](../llm.md) — all builders, patterns, and error codes in one file.

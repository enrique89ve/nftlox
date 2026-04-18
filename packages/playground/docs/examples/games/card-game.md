# Example — Card Game (TCG)

A full TCG flow built on NFTLox: launch the hero catalogue, distribute cards from packs, let players trade on the marketplace, and patch card stats between seasons. Every snippet uses the real SDK and `hive-tx`.

The moving parts we cover:

1. **Launch.** `buildCollectionWithSeeds` ships the collection + every hero seed in one orchestrated call.
2. **Pack distribution.** `buildBulkDistribute` hands out instances to players.
3. **Trading.** `buildList` / `buildBuy` for player-to-player transfers.
4. **Seasonal rebalancing.** `buildSetDataFrom` lets the game server patch `mutableData` without asking players for keys.
5. **Lending.** `buildNftLend` / `buildNftReturn` for card rentals during tournaments.

## Shared scaffolding

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
const SERVER = "ragnarok-server";
const ACTIVE = hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!);
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

## 1. Launch the catalogue

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

// Collection step (dual-signer: creator active + node multisig)
const colTx = new hive.Transaction();
await colTx.create(plan.collectionStep.operations as [string, object][]);
const sig = await requestCreateCollectionMultisig(INDEXER, { transaction: colTx.transaction });
if (!sig.ok) throw new MultisigError({ message: sig.message, code: sig.code, url: INDEXER });
colTx.transaction.signatures.push(sig.signature);
colTx.sign(ACTIVE);
const colTxId = (await colTx.broadcast()).result.tx_id;

// Seed batches (posting-only)
for (const batch of plan.seedBatches) {
	await broadcast(batch.operations, POSTING);
	await new Promise(r => setTimeout(r, 4000));
}

// Grant the game server permission to update mutable stats
const grant = buildDataOperatorApprove({
	creator: CREATOR, collectionId: plan.collectionId,
	operator: SERVER, approved: true,
});
if (grant.success) await broadcast(grant.operations, POSTING);
```

## 2. Open a booster pack

A "pack" in NFTLox-speak is just a server-side random roll followed by a single `bulk_distribute`. Rarity odds live in your server; the chain records the resulting instances.

```typescript
function rollPack(): { seedId: string; quantity: number }[] {
	const roll = Math.random();
	const rare    = plan.generatedIds["mage"]!;
	const common  = plan.generatedIds["warrior"]!;
	const legend  = plan.generatedIds["dragon"]!;
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

Packs are cheap (one broadcast per pack) and the indexer emits per-instance events so your UI can render the reveal animation off a websocket or a poll of `getOperationStatus`.

## 3. Player lists a card for sale

```typescript
async function listCard(owner: string, nftId: string, priceHive: string) {
	const result = await buildList({
		owner,
		nftId,
		price: { amount: priceHive, currency: "HIVE" },
		expiresAt: Date.now() + 7 * 24 * 3600 * 1000,   // 7 days
		marketplace: "ragnarok",
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	// Player signs with their own posting key (handled by Keychain in a real UI)
	return broadcast(result.operations, POSTING);
}
```

The `marketplace` tag ("ragnarok") scopes the listing. UIs filtering by that tag will see only Ragnarok listings; the protocol-wide marketplace aggregates everything.

## 4. Another player buys the card

```typescript
async function buyCard(buyer: string, nftId: string) {
	const payment = await client.getPaymentInfo(nftId);
	const result = buildBuy({
		buyer,
		seller: payment.seller,
		nftId: payment.nftId,
		listingId: payment.listingId,
		listTxId: payment.listTxId,
		txId: payment.txId,
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
	tx.sign(ACTIVE);           // in a browser, Keychain supplies this signature
	await tx.broadcast();
}
```

`getPaymentInfo` returns the exact split (seller net, royalty, protocol fee); never compute these numbers yourself — the node will reject any mismatch with `INVALID_PAYMENT_SPLIT`.

## 5. Server-side stat updates after a match

```typescript
async function recordWin(nftId: string, xpEarned: number) {
	const nft = await client.getNft(nftId);
	const wins = (nft.mutable_data?.wins as number ?? 0) + 1;
	const xp   = (nft.mutable_data?.xp as number ?? 0) + xpEarned;
	const level = Math.min(100, Math.floor(xp / 1000) + 1);

	const result = buildSetDataFrom({
		operator: SERVER,
		nftId,
		instanceDna: nft.instance_dna!,
		mutableData: { xp, level, wins },
	});
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, SERVER_POSTING);
}
```

Because the server signs with its own posting key under an approval, the player never leaks a key to the game. Revoking the approval (`approved: false`) immediately halts server-side updates.

## 6. Tournament rentals — lending

Let a player lend a legendary card to a teammate for a tournament weekend. While lent, the card cannot be listed, transferred, or re-lent.

```typescript
async function lend(owner: string, instanceId: string, borrower: string) {
	const result = buildNftLend({ owner, instanceId, borrower });
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, POSTING);
}

async function returnCard(borrower: string, instanceId: string) {
	const result = buildNftReturn({ owner: borrower, instanceId });
	if (!result.success) throw new Error(JSON.stringify(result.errors));
	return broadcast(result.operations, POSTING);
}
```

Only the current borrower can call `nft_return`. The owner's rights are restored immediately on return — no cooldown.

## What we didn't broadcast

Everything in `data` that isn't declared in the schema is ignored by the indexer. Keep per-match telemetry, deck compositions, matchmaking rating, etc. off-chain and only write to the NFT when the state is worth the cost of a broadcast (level-ups, titles, permanent stat bumps). Use a content hash in `mutableData` if you want to commit to a blob without paying to publish it.

## See also

- [Seed Ceremony](../seed-ceremony.md) — the collection launch step in isolation.
- [Mutable Data](../mutable-data.md) — deeper dive into `set_data` / `set_data_from`.
- [Marketplace Trading](../../guides/marketplace.md) — listing lifecycle and fee mechanics.
- [Allowances & Operators](../../guides/allowances.md) — full permission model.
- [NFT Lending](../../guides/lending.md) — lender/borrower state transitions.

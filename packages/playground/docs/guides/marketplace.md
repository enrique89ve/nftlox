# Marketplace Trading

Peer-to-peer NFT trading on Hive. Listings are pure on-chain state; buys settle atomically with HIVE/HBD transfers + an ownership change, co-signed by the indexer node so a buyer can never pay for an NFT that is not actually deliverable.

## Lifecycle

```
list   (owner, posting)          → NFT status: listed, listingId/listingNonce recorded
unlist (owner, posting)          → returns to active after UNLIST_DELAY_BLOCKS (3) blocks
buy    (buyer, active + node)    → transfers + custom_json in one atomic tx
```

- `list`, `unlist` — posting key. Cheap, single-signer.
- `buy` — **active key** (HIVE/HBD transfers) + **node multisig** (the `custom_json` has `required_auths: [nodeAccount]`).
- Supported currencies: `HIVE`, `HBD`.
- Protocol fee: **1%** (`PROTOCOL_FEE_BPS = 100`).
- Max royalty: **50%** (`MAX_ROYALTY_PCT`), set per-collection at creation.

## 1. Listing — `buildList`

```typescript
import { buildList } from "nftlox-sdk";
import hive from "hive-tx";

hive.config.set("node", "https://api.hive.blog");

const result = await buildList({
	owner: "alice",
	nftId: "nft_abc…_7",
	price: { amount: "25.000", currency: "HIVE" },
	expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
	marketplace: "ragnarok",           // optional scope tag, used by UIs to filter
	imageUrl: "https://…/nft.png",     // optional; SDK hashes it for indexer verification
});
if (!result.success) throw new Error(JSON.stringify(result.errors));

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.sign(hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!));
await tx.broadcast();

// result.generatedIds = { listingId, listingNonce }
```

**What the builder computes for you:**

- `listingNonce` — random 16-byte hex, included in the hash so the same NFT can be re-listed without collision.
- `listingId = sha256(domain | nftId | owner | marketplace | price | expiresAt | nonce)` — deterministic, verifiable off-chain.
- `imageHash` if you pass `imageUrl` (the indexer compares hashes on first sight).

**Indexer validation:**

- Instance exists, not burned, not lent, not already listed (lazy: an expired listing is cleared on touch).
- Signer is the current owner.
- Collection is `transferable`.
- `listingId` matches the recomputed hash.

`marketplace` is a free-form tag (`"ragnarok"`, `"peakd"`, …). Your UI filters `getListings({ marketplace })` to isolate your storefront; the protocol-wide feed sees everything.

## 2. Unlisting — `buildUnlist`

```typescript
import { buildUnlist } from "nftlox-sdk";

const result = await buildUnlist({
	owner: "alice",
	nftId: "nft_abc…_7",
});
```

An unlist is effective immediately for UI purposes, but the NFT cannot be re-listed for **`UNLIST_DELAY_BLOCKS = 3`** blocks (~9 s). This tiny cooldown blocks a race where a seller unlists to dodge an in-flight buy and re-lists at a higher price in the same window.

## 3. Buying — `buildBuy`

Buying is a three-step dance: fetch the split, build the tx, get the node to co-sign.

### Step 1 — fetch the payment split

Always read it from the indexer. Any mismatch (seller/royalty/fee amounts, currency, listingId, listTxId) is rejected by the multisig node with `INVALID_PAYMENT_SPLIT`.

```typescript
import { createIndexerClient } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");
const info = await client.getPaymentInfo("nft_abc…_7");
// {
//   nftId, listingId, listTxId, seller,
//   totalPrice, currency: "HIVE" | "HBD",
//   sellerAmount, royaltyAmount, royaltyRecipient,
//   feeAmount, feeAccount, nodeAccount,
//   txId, seedTxId
// }
```

### Step 2 — build the transaction

`buildBuy` returns `operations` as a flat array: up to 3 `transfer` ops followed by the `custom_json` with `required_auths: [nodeAccount]`. The buyer signs the transfers with **active**. The node adds its signature to authorize the `custom_json`.

```typescript
import { buildBuy } from "nftlox-sdk";

const result = buildBuy({
	buyer: "bob",
	seller: info.seller,
	nftId: info.nftId,
	listingId: info.listingId,
	listTxId: info.listTxId,
	txId: info.txId,
	nodeAccount: info.nodeAccount,
	paymentSplit: {
		sellerAmount: info.sellerAmount,
		royaltyAmount: info.royaltyAmount,
		royaltyRecipient: info.royaltyRecipient,
		feeAmount: info.feeAmount,
		feeAccount: info.feeAccount,
		totalPrice: info.totalPrice,
		currency: info.currency as "HIVE" | "HBD",
	},
});
if (!result.success) throw new Error(JSON.stringify(result.errors));
```

The builder refuses to return operations if `buyer === seller` (error code `CANNOT_BUY_OWN`).

### Step 3 — multisig + broadcast

```typescript
import { MultisigError } from "nftlox-sdk";

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);

const resp = await client.multisig({
	buyer: "bob",
	nftId: info.nftId,
	listingId: info.listingId,
	listTxId: info.listTxId,
	transaction: tx.transaction,
});
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: INDEXER });

tx.transaction.signatures.push(resp.signature);
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));
await tx.broadcast();
```

In a browser UI, swap the active-key sign step for Hive Keychain's `requestBroadcast` with `"Active"` authority — the node signature was already appended, so Keychain is only responsible for the user's signature.

### Multisig rejection codes

| Code | Cause |
|---|---|
| `RATE_LIMITED` | Too many requests from this IP. Back off. |
| `INVALID_TX_STRUCTURE` | Wrong op count, bad order, expired window, missing fields. |
| `NFT_NOT_FOUND` | nftId unknown to the indexer. |
| `NFT_NOT_LISTED` | Listing was cancelled / expired / bought by someone else. |
| `NFT_NOT_TRANSFERABLE` | Collection `rules.transferable = false`. |
| `NFT_EXPIRED_LISTING` | `expiresAt` in the past. Ask the seller to re-list. |
| `CANNOT_BUY_OWN` | Buyer == seller. |
| `SEED_HAS_INSTANCES` | Seeds with distributed instances cannot be sold (seed is co-owned in spirit by its instance holders). |
| `INVALID_PAYMENT_SPLIT` | Any transfer amount off by even 0.001 from the split the node computed. |
| `INVALID_PROTOCOL_PAYLOAD` | `listingId`/`listTxId` don't match the active listing, memos malformed, or `required_auths` missing the node. |
| `NFT_LOCKED` | Another in-flight buy holds the DB-backed lock. Retry after ~60 s. |

The node's checklist before co-signing:

- Transaction has 2–4 ops (≥1 transfer + the custom_json; ≤3 transfers + the custom_json).
- Expiration is 30–120 s away.
- `custom_json.required_auths` contains the node account.
- NFT listed, not burned/lent, collection transferable.
- Split matches exactly (rounded to 3 decimals, Hive precision).
- Memos follow the `NFTLox {BUY|ROY|FEE}:{nftId}` format.
- No competing in-flight buy — the indexer stores a `multisig_locks` row so concurrent API instances behind a load balancer stay coherent.

## Payment split

```
feeAmount     = round3(totalPrice * PROTOCOL_FEE_BPS / 10_000)    // 1%
royaltyAmount = round3(totalPrice * royaltyPct    / 100)
sellerAmount  = totalPrice - royaltyAmount - feeAmount
```

The server-side math is authoritative. `buildBuy` does not recompute it — it trusts whatever `paymentSplit` you pass, and the node rejects anything that drifts.

### Merging rules

The builder emits a `transfer` only for amounts `> 0`. So:

- `royaltyAmount == 0` → 2 transfers (seller + fee).
- `feeAmount == 0` → (happens only if the node is configured with no fee) — 2 transfers.
- `royaltyRecipient === seller` → set the royalty transfer off by merging upstream; the node computes a single larger seller transfer. Same for `feeAccount === seller`.
- Minimum: 1 transfer + custom_json (total 2 ops).

### Memo format

Strict. The node and the indexer both verify it.

| Transfer | Memo | Constant |
|---|---|---|
| Seller payment | `NFTLox BUY:{nftId}` | `MEMO_PREFIX_BUY` |
| Royalty | `NFTLox ROY:{nftId}` | `MEMO_PREFIX_ROYALTY` |
| Protocol fee | `NFTLox FEE:{nftId}` | `MEMO_PREFIX_FEE` |

No space after the colon; `{nftId}` is the exact `nft_…` string from the payload.

## Why the multisig exists

Without co-signing, a malicious seller could list an NFT, watch for an in-flight `buy`, transfer it out to an alt in a racing transaction, and still collect the buyer's HIVE. The multisig kills that race:

1. Buyer builds transfers + `custom_json(required_auths = [node])` as one atomic tx.
2. Node checks *at the moment of signing* that the listing is still live, split is correct, and no competing buy holds the lock.
3. Node appends its signature; buyer appends theirs; broadcast.
4. Because Hive evaluates the whole transaction atomically, either all three transfers + the ownership change land, or nothing does.

Transactions expire in 30–120 s. A stolen node signature is useless within a minute, and the `multisig_locks` row prevents two buyers from collecting a signature on the same listing at the same time.

## Querying the marketplace

```typescript
const listings = await client.getListings({
	sort: "price_asc",              // or "price_desc" | "newest" | "oldest"
	currency: "HIVE",               // optional filter
	limit: 20,
	offset: 0,
});

for (const nft of listings) {
	console.log(nft.name, nft.listing_price, nft.listing_currency);
}

// Completed sales (history)
const sales = await client.getSales({ seller: "alice", limit: 50 });
// { gross_amount, seller_net, royalty_amount, protocol_fee, currency, tx_id, created_at, … }

// Aggregated volume
const volume = await client.getSalesVolume({ collectionId: "col_…" });
// [{ currency, total_sales, volume, total_royalties, total_fees }]
```

`getListings` delegates to `/api/marketplace/listings`. Listing history (create/cancel events) is **not** stored locally — reconstruct it from HafAH if you need it.

## Listing expiration is lazy

The indexer does not sweep expired listings on a timer. An expired listing stays `listed` in the DB until something touches the NFT — another `list`, a `buy` attempt, a transfer — at which point the status flips back to `active` before the touching op is applied. For UIs, compare `expiresAt` against `Date.now()` when rendering.

## See also

- [Signing & Broadcasting](../broadcasting.md#3-buy--active--multisig) — the multisig merge step line by line.
- [Data Formats — `list`, `unlist`, `buy`](../data-formats.md#list) — payload shapes + deterministic ID derivation.
- [SDK Reference — marketplace builders](../sdk/reference.md#marketplace) — full input surface.
- [Allowances & Operators](allowances.md#operator-initiated-transfer--buildnfttransferfrom) — why `nft_transfer_from` is blocked while an instance is listed.

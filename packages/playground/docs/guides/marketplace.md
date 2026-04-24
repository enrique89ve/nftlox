# Marketplace Trading

Peer-to-peer NFT trading on Hive. Listings are pure on-chain state; buys settle atomically with HIVE/HBD transfers + an ownership change, co-signed by the indexer node so a buyer can never pay for an NFT that is not actually deliverable.

## Lifecycle

```
list           (owner, posting)             → NFT status: listed, listingId/listingNonce recorded
unlist         (owner, posting)             → clears the listing immediately; blocked while a buy_commitment holds the NFT
buy_commitment (node,  active, server-side) → reserves the NFT in pending_sale, emitted by the settlement node
buy            (buyer, active  +  node)     → transfers + custom_json, broadcast by the node after its commitment wins
```

- `list`, `unlist` — posting key. Cheap, single-signer.
- `buy` — **active key** (HIVE/HBD transfers, signed locally by the buyer) + **node active** on the trailing `custom_json` (`required_auths: [nodeAccount]`). The buyer POSTs the already-signed transaction to `/api/multisig/buy`; the node drives the remainder of settlement.
- `buy_commitment` — **node-only**, active-auth. Not a client-facing operation: the settlement node emits it on chain to reserve the NFT before co-signing the `buy`.
- Supported currencies: `HIVE`, `HBD`.
- Protocol fee: **1%** (`PROTOCOL_FEE_BPS = 100`).
- Max royalty: **50%** (`MAX_ROYALTY_PCT`), set per-collection at creation.
- Minimum listing TTL: **`MIN_LISTING_TTL_MS = 240_000`** (4 min). Derived from `LISTING_MIN_DURATION_BLOCKS × 3_000 ms + 60_000 ms` so a listing always outlives the full buy-settlement window (commitment broadcast + inclusion wait + co-sign + buy broadcast). See [Why listings need a minimum TTL](#why-listings-need-a-minimum-ttl).

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

Unlist is instantaneous: the listing row is cleared in the same block. Race protection against in-flight settlements comes from the `buy_commitment` gate — a settlement node that has already broadcast a commitment holds the NFT as `status = "pending_sale"`, and `handleUnlist` refuses to touch any `pending_sale` row. The NFT returns to `active` only when the matching `buy` settles or the commitment TTL (`BUY_COMMITMENT_TTL_BLOCKS`) expires.

## 3. Buying — `buildBuy` (node-last)

Buying is a three-step dance: fetch the split, build + sign the tx, hand it to the settlement node. The node — not the buyer — broadcasts the completed transaction after winning the cross-node ordering race.

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

`buildBuy` returns `operations` as a flat array: up to 3 `transfer` ops followed by the `custom_json` with `required_auths: [nodeAccount]`. The buyer signs the **full** transaction with their active key before submitting it to the node — the node appends its own active signature only after its `buy_commitment` wins.

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

### Step 3 — sign locally, then hand off to the node

```typescript
import {
	MultisigError,
	requestBuyMultisig,
	RECOMMENDED_BUY_TX_EXPIRATION_MS,
} from "nftlox-sdk";

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);

// Pin expiration inside the accepted window (30–120s). 60s recommended.
tx.transaction.expiration = new Date(
	Date.now() + RECOMMENDED_BUY_TX_EXPIRATION_MS,
).toISOString().slice(0, 19);

// Buyer signs the full transaction BEFORE POSTing.
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));

// Hand off to the settlement node: it broadcasts buy_commitment, waits for
// its commitment to win the cross-node race, appends its own signature,
// and broadcasts the completed buy.
const resp = await requestBuyMultisig(INDEXER, { transaction: tx.transaction });
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: INDEXER });

console.log("Settled buy tx:", resp.txId);
console.log("Commitment op tx:", resp.commitmentOpTxId);
```

In a browser UI, swap the local active-key sign step for Hive Keychain's `requestSignTx` / `requestSignedTx` to obtain the buyer's signature, then POST the signed transaction to `/api/multisig/buy`. You never call `requestBroadcast` — the node does the broadcast.

> The request body is just `{ transaction }`. The buyer account is derived server-side from the first transfer's `from` field.

### Multisig rejection codes (buy)

| Code | Cause |
|---|---|
| `RATE_LIMITED` | Too many requests from this IP or buyer. Back off `retryAfterMs`. |
| `INVALID_TX_STRUCTURE` | Wrong op count/order, expiration outside 30–120s, missing fields. |
| `BUYER_SIGNATURE_MISSING` | Transaction POSTed without the buyer's active signature. |
| `MISSING_BUYER_AUTH` | First transfer's `from` is missing or malformed. |
| `NODE_ACCOUNT_MISMATCH` | `custom_json.required_auths` does not contain this node account. |
| `NFT_NOT_FOUND` | nftId unknown to the indexer. |
| `NFT_NOT_LISTED` | Listing was cancelled / expired / already sold. |
| `NFT_NOT_INSTANCE` | Only instances are sellable (seeds are not). |
| `NFT_NOT_TRANSFERABLE` | Collection `rules.transferable = false`. |
| `NFT_EXPIRED_LISTING` | `expiresAt` in the past. Ask the seller to re-list. |
| `CANNOT_BUY_OWN` | Buyer == seller. |
| `SEED_HAS_INSTANCES` | Seeds with distributed instances cannot be sold. |
| `INVALID_PAYMENT_SPLIT` | Any transfer amount off by even 0.001 from the node's computed split. |
| `INVALID_PROTOCOL_PAYLOAD` | `listingId`/`listTxId` don't match the active listing, or payload malformed. |
| `NFT_LOCKED` | Another buy for this NFT is already in flight on **this** node (process-local lock). Retry. |
| `CROSS_NODE_RESERVATION` | A different settlement node's `buy_commitment` landed first. Listing is now settled or reserved elsewhere. |
| `COMMITMENT_BROADCAST_FAILED` | Node could not broadcast its `buy_commitment` to Hive. Transient — retry. |
| `COMMITMENT_INCLUSION_TIMEOUT` | Node's commitment never made it into a block within the TTL window (~30 s). Transient — retry. |
| `BUY_BROADCAST_FAILED` | Node's final buy broadcast failed. Listing state is unchanged; retry. |
| `INDEXER_LAGGED` | Indexer is more than `BUY_API_LAG_MAX_BLOCKS` (3 blocks) behind Hive HEAD. Transient. |
| `NODE_NOT_ACTIVE` | Node missed too many heartbeats and no longer serves settlement. Use a different indexer. |
| `SIGNING_QUEUE_FULL` / `SIGNING_TIMEOUT` | Beekeeper queue saturated or timed out. Transient. |
| `MULTISIG_DISABLED` | Node has no `ACTIVE_KEY` configured or is in clock-drift safeguard. Use a different indexer. |
| `POW_REQUIRED` / `INVALID_POW` / `POW_EXPIRED` / `POW_REPLAYED` | PoW token missing, invalid, stale, or reused. SDK handles this automatically. |

The node's checklist before broadcasting its commitment:

- Transaction has 2–4 ops (1–3 `transfer`s + the trailing `custom_json`).
- `expiration` ∈ `[MULTISIG_TX_MIN_EXPIRATION_MS, MULTISIG_TX_MAX_EXPIRATION_MS]` (30–120 s).
- Buyer's active signature already present on the transaction.
- `custom_json.required_auths` contains the node account.
- NFT listed, not burned/lent, collection transferable.
- Split matches exactly (rounded to 3 decimals, Hive precision).
- Memos follow the `NFTLox {BUY|ROY|FEE}:{nftId}` format.
- No competing in-flight buy on this node (process-local `buyLock`). Cross-node contention is resolved on chain through `buy_commitment` ordering, not a DB table.

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
| Collection creation fee | `NFTLox FEE-COL:{collectionId}` | `MEMO_PREFIX_FEE_COL` |

No space after the colon; `{nftId}` is the exact `nft_…` string from the payload. The collection-fee memo uses the canonical `collectionId` (`col_…`).

## Why the multisig exists

Without co-signing, a malicious seller could list an NFT, watch for an in-flight `buy`, transfer it out to an alt in a racing transaction, and still collect the buyer's HIVE. The multisig kills that race, and the 0.7.0 **node-last** orchestration kills the cross-node race too:

1. Buyer builds `transfers + custom_json(required_auths = [node])` in one atomic tx and signs it with their active key.
2. Buyer POSTs the signed tx to `/api/multisig/buy`. No node signature yet, no broadcast yet — the buyer's signature cannot move funds until the node joins it.
3. Node validates (listing live, split exact, memos right, expiration in-window) and **broadcasts a `buy_commitment`** custom_json on Hive, reserving the NFT in `pending_sale`.
4. Node waits for its commitment to land in a block. If a different node's commitment for the same NFT lands first, Hive's block ordering awards the win to that node and ours returns `CROSS_NODE_RESERVATION`.
5. Once our commitment wins, the node appends its active signature to the buyer-signed tx and broadcasts it itself. Hive evaluates the entire transaction atomically, so either all transfers + the ownership change land or nothing does.

Transactions expire in 30–120 s (`MULTISIG_TX_MIN/MAX_EXPIRATION_MS`). `buy_commitment` reservations expire in `BUY_COMMITMENT_TTL_BLOCKS` (~30 s), so a commitment that fails to settle automatically releases the NFT back to `listed`.

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

## Why listings need a minimum TTL

Buy settlement is a multi-step orchestration: validate → broadcast `buy_commitment` → wait for inclusion (up to `BUY_COMMITMENT_TTL_BLOCKS` ≈ 30 s) → co-sign → broadcast the buy (expiration ≤ 120 s). The listing must outlive the worst case, or a late-submitted buy can have its commitment land *after* the listing expires. The protocol floor:

- `MIN_LISTING_TTL_MS = LISTING_MIN_DURATION_BLOCKS × 3_000 ms + 60_000 ms` = `60 × 3_000 + 60_000` = **240 000 ms** (4 min).

Two layers enforce it:

| Layer | Check |
|---|---|
| SDK | `listInputSchema` rejects `expiresAt <= Date.now() + MIN_LISTING_TTL_MS`. |
| Indexer consensus | `handleList` rejects `expiresAt <= blockTimestamp + MIN_LISTING_TTL_MS`. `/api/multisig/buy` additionally rejects any buy whose listing is already expired (`NFT_EXPIRED_LISTING`). |

Without this floor a seller could list with a 5 s expiry, collect a buyer-signed tx, and have the indexer reject the ownership change because the listing "expired" mid-settlement — a trivial way to sink a buyer's funds.

## See also

- [Signing & Broadcasting](../broadcasting.md#flow-2--buying-node-last) — the node-last buy flow line by line.
- [Data Formats — `list`, `unlist`, `buy`](../data-formats.md#list) — payload shapes + deterministic ID derivation.
- [SDK Reference — marketplace builders](../sdk/reference.md#marketplace) — full input surface.
- [Allowances & Operators](allowances.md#operator-initiated-transfer--buildnfttransferfrom) — why `nft_transfer_from` is blocked while an instance is listed.

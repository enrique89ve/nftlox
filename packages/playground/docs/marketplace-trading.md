# Marketplace Trading

The NFTLox marketplace enables peer-to-peer NFT trading on Hive. It follows a **list / buy / unlist** cycle secured by multisig co-signing -- the indexer node validates every purchase before co-signing the transaction, ensuring funds only move when the sale is legitimate.

---

## Lifecycle Overview

```
Owner lists NFT (active key)
  └── NFT status changes to "listed" with price, currency, and listingId

Buyer purchases NFT (multisig flow)
  ├── 1. Fetch payment info from indexer
  ├── 2. Build buy transaction with payment splits
  ├── 3. Request multisig co-signature from node
  ├── 4. Append buyer signature + node signature
  └── 5. Broadcast to Hive

Owner unlists NFT (posting key)
  └── NFT status reverts to "active", listing cleared
```

**Key facts:**

- `list` and `buy` require **active key** (custody transfer / financial operation)
- `unlist` requires **posting key** (safe, protective action)
- Supported currencies: `HIVE`, `HBD`
- Protocol fee: **1.0%** (goes to the co-signing node)
- Maximum royalty: **50%**

---

## 1. Listing an NFT

### API: POST /api/build/list

Builds an unsigned `custom_json` operation that lists an NFT for sale. The SDK generates a deterministic `listingId` and random `listingNonce` automatically.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | yes | Hive account that owns the NFT |
| `nftId` | string | yes | NFT identifier |
| `price` | object | yes | `{ amount: "10.000", currency: "HIVE" }` |
| `expiresAt` | number | no | Unix timestamp (ms) -- must be in the future |
| `imageUrl` | string | no | Image URL for indexer verification |
| `marketplace` | string | no | Marketplace identifier (for filtering) |

**Example request:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/list \
	-H "Content-Type: application/json" \
	-d '{
		"owner": "alice",
		"nftId": "nft_a1b2c3d4e5f6",
		"price": { "amount": "25.000", "currency": "HIVE" }
	}'
```

**Example response:**

```json
{
	"success": true,
	"protocolVersion": "0.4.1",
	"operation": ["custom_json", {
		"required_auths": ["alice"],
		"required_posting_auths": [],
		"id": "nftlox_testnet",
		"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.4.1\",\"action\":\"list\",\"data\":{\"nftId\":\"nft_a1b2c3d4e5f6\",\"listingId\":\"list_abc123def456...\",\"listingNonce\":\"r4nd0mn0nc3\",\"price\":{\"amount\":\"25.000\",\"currency\":\"HIVE\"}}}"
	}],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.4.1",
		"action": "list",
		"data": {
			"nftId": "nft_a1b2c3d4e5f6",
			"listingId": "list_abc123def456...",
			"listingNonce": "r4nd0mn0nc3",
			"price": { "amount": "25.000", "currency": "HIVE" }
		}
	}
}
```

### SDK usage

```typescript
import { buildList } from "nftlox-sdk";

const result = await buildList({
	owner: "alice",
	nftId: "nft_a1b2c3d4e5f6",
	price: { amount: "25.000", currency: "HIVE" },
});

if (!result.success) {
	console.error(result.errors);
	return;
}

// result.operation -- sign with active key and broadcast
// result.payload.data.listingId -- deterministic listing ID
```

### Validation rules (indexer)

- NFT must exist and not be burned, lent, or a distributed seed
- Signer must be the NFT owner
- Collection must be `transferable`
- NFT must not already be listed (unless the previous listing expired)
- `listingId` must match the deterministic hash of `(nftId, owner, marketplace, price, expiresAt, nonce)`

---

## 2. Buying an NFT

Buying is the most complex marketplace operation. It uses a **multisig co-signing flow** where the indexer node validates the transaction and provides its signature before broadcast.

### Step-by-step flow

```
┌─────────┐       ┌───────────┐       ┌──────────────┐
│  Buyer  │──1──▶│  Indexer  │       │  Hive Chain  │
│  Client │◀──2──│  Node     │       │              │
│         │──3──▶│           │       │              │
│         │◀──4──│           │       │              │
│         │──5───────────────────────▶│              │
└─────────┘       └───────────┘       └──────────────┘

1. GET /api/payment-info/{nftId}     → payment split details
2. Response: seller/royalty/fee amounts + listingId + listTxId
3. POST /api/multisig                → unsigned tx with transfers
4. Response: node signature + digest
5. Broadcast tx with both signatures → ownership transfers
```

### Step 1: Fetch payment info

```bash
curl https://api-nftlox.hivecreators.co/api/payment-info/nft_a1b2c3d4e5f6
```

**Response:**

```json
{
	"nftId": "nft_a1b2c3d4e5f6",
	"listingId": "list_abc123def456...",
	"listTxId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
	"seller": "alice",
	"totalPrice": 25.0,
	"currency": "HIVE",
	"sellerAmount": 24.5,
	"royaltyAmount": 0.25,
	"royaltyRecipient": "artist",
	"feeAmount": 0.25,
	"feeAccount": "nftlox",
	"nodeAccount": "nftlox",
	"txId": "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1",
	"seedTxId": null
}
```

### Step 2: Build buy transaction

Use the payment info to build the full transaction with all transfer operations.

**API: POST /api/build/buy**

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `buyer` | string | yes | Hive account buying the NFT |
| `seller` | string | yes | Current NFT owner |
| `nftId` | string | yes | NFT identifier |
| `listingId` | string | yes | Active listing ID (from payment info) |
| `listTxId` | string | yes | Transaction ID that created the listing |
| `txId` | string | yes | NFT creation transaction ID |
| `nodeAccount` | string | yes | Co-signing node account |
| `paymentSplit` | object | yes | Full split object from payment info |

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/buy \
	-H "Content-Type: application/json" \
	-d '{
		"buyer": "bob",
		"seller": "alice",
		"nftId": "nft_a1b2c3d4e5f6",
		"listingId": "list_abc123def456...",
		"listTxId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		"txId": "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1",
		"nodeAccount": "nftlox",
		"paymentSplit": {
			"sellerAmount": 24.5,
			"royaltyAmount": 0.25,
			"royaltyRecipient": "artist",
			"feeAmount": 0.25,
			"feeAccount": "nftlox",
			"totalPrice": 25.0,
			"currency": "HIVE"
		}
	}'
```

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.4.1",
	"keyType": "Active",
	"hiveOperations": [
		["transfer", {
			"from": "bob",
			"to": "alice",
			"amount": "24.500 HIVE",
			"memo": "NFTLox BUY:nft_a1b2c3d4e5f6"
		}],
		["transfer", {
			"from": "bob",
			"to": "artist",
			"amount": "0.250 HIVE",
			"memo": "NFTLox ROY:nft_a1b2c3d4e5f6"
		}],
		["transfer", {
			"from": "bob",
			"to": "nftlox",
			"amount": "0.250 HIVE",
			"memo": "NFTLox FEE:nft_a1b2c3d4e5f6"
		}],
		["custom_json", {
			"required_auths": ["nftlox"],
			"required_posting_auths": [],
			"id": "nftlox_testnet",
			"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.4.1\",\"action\":\"buy\",\"data\":{\"nftId\":\"nft_a1b2c3d4e5f6\",\"listingId\":\"list_abc123def456...\",\"listTxId\":\"a1b2c3d4...\",\"txId\":\"f0e1d2c3...\"}}"
		}]
	],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.4.1",
		"action": "buy",
		"data": {
			"nftId": "nft_a1b2c3d4e5f6",
			"listingId": "list_abc123def456...",
			"listTxId": "a1b2c3d4...",
			"txId": "f0e1d2c3..."
		}
	}
}
```

Note that `hiveOperations` contains **up to 4 operations**: seller transfer, royalty transfer (if applicable), fee transfer, and the `custom_json`. The `custom_json` has `required_auths: [nodeAccount]` -- this is why multisig co-signing is needed.

### Step 3: Request multisig co-signature

Wrap the operations in a Hive transaction and send it to the node for co-signing.

**POST /api/multisig**

```bash
curl -X POST https://api-nftlox.hivecreators.co/api/multisig \
	-H "Content-Type: application/json" \
	-d '{
		"buyer": "bob",
		"nftId": "nft_a1b2c3d4e5f6",
		"listingId": "list_abc123def456...",
		"listTxId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		"transaction": {
			"ref_block_num": 12345,
			"ref_block_prefix": 678901234,
			"expiration": "2026-03-30T12:05:00",
			"operations": [
				["transfer", { "from": "bob", "to": "alice", "amount": "24.500 HIVE", "memo": "NFTLox BUY:nft_a1b2c3d4e5f6" }],
				["transfer", { "from": "bob", "to": "artist", "amount": "0.250 HIVE", "memo": "NFTLox ROY:nft_a1b2c3d4e5f6" }],
				["transfer", { "from": "bob", "to": "nftlox", "amount": "0.250 HIVE", "memo": "NFTLox FEE:nft_a1b2c3d4e5f6" }],
				["custom_json", { "required_auths": ["nftlox"], "required_posting_auths": [], "id": "nftlox_testnet", "json": "..." }]
			],
			"extensions": [],
			"signatures": []
		}
	}'
```

**Success response:**

```json
{
	"ok": true,
	"signature": "1f4a5b6c7d8e9f...",
	"digest": "abc123def456...",
	"expiration": "2026-03-30T12:05:00"
}
```

**Error response:**

```json
{
	"ok": false,
	"code": "INVALID_PAYMENT_SPLIT",
	"message": "Seller transfer amount mismatch: expected 24.500, got 24.000"
}
```

### Step 4: Sign and broadcast

After receiving the node's signature, append the buyer's signature and broadcast:

```typescript
import { Transaction, PrivateKey } from "hive-tx";

// Add node signature from multisig response
transaction.signatures.push(multisigResponse.signature);

// Sign with buyer's active key
const tx = new Transaction(transaction);
tx.sign(PrivateKey.from(buyerActiveKey));

// Broadcast
const result = await tx.broadcast();
```

### SDK usage (full flow)

```typescript
import { createIndexerClient, buildBuy } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");

// 1. Fetch payment info
const info = await client.getPaymentInfo("nft_a1b2c3d4e5f6");

// 2. Build buy transaction
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
		currency: info.currency,
	},
});

if (!result.success) {
	console.error(result.errors);
	return;
}

// 3. Build Hive transaction from hiveOperations
// 4. Request multisig co-signature
const multisig = await client.multisig({
	buyer: "bob",
	nftId: info.nftId,
	listingId: info.listingId,
	listTxId: info.listTxId,
	transaction: hiveTransaction, // built from result.hiveOperations
});

if (!multisig.ok) {
	console.error(multisig.code, multisig.message);
	return;
}

// 5. Append both signatures and broadcast
```

### Multisig error codes

| Code | Description |
|---|---|
| `RATE_LIMITED` | Too many requests from this IP |
| `INVALID_TX_STRUCTURE` | Malformed transaction (wrong operation count, expired, missing fields) |
| `NFT_NOT_FOUND` | NFT does not exist |
| `NFT_NOT_LISTED` | NFT is not currently listed for sale |
| `NFT_NOT_TRANSFERABLE` | Collection rules forbid transfers |
| `NFT_EXPIRED_LISTING` | Listing has expired |
| `CANNOT_BUY_OWN` | Buyer is the same account as the seller |
| `SEED_HAS_INSTANCES` | Seed NFTs with distributed instances cannot be sold |
| `INVALID_PAYMENT_SPLIT` | Transfer amounts do not match expected split |
| `INVALID_PROTOCOL_PAYLOAD` | Custom JSON payload is malformed or listingId/listTxId mismatch |

### Multisig validation rules

The node validates the following before co-signing:

- Transaction has 2-4 operations (minimum: 1 transfer + 1 custom_json; maximum: 3 transfers + 1 custom_json)
- Transaction expiration is between 30s and 120s from now
- `custom_json` `required_auths` contains the node account
- NFT exists, is listed, not burned, not lent, not a distributed seed
- Collection is transferable
- Buyer is not the seller
- `listingId` and `listTxId` match the active listing in the database
- Payment transfers match the calculated split exactly (seller + royalty + fee)
- Memo format is correct on each transfer

---

## 3. Unlisting an NFT

### API: POST /api/build/unlist

Builds an unsigned `custom_json` that cancels an active listing. Uses **posting key** -- this is a safe, non-custodial operation.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | yes | NFT owner (must match listed NFT) |
| `nftId` | string | yes | NFT identifier |
| `imageUrl` | string | no | Image URL for verification |

**Example request:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/unlist \
	-H "Content-Type: application/json" \
	-d '{
		"owner": "alice",
		"nftId": "nft_a1b2c3d4e5f6"
	}'
```

**Example response:**

```json
{
	"success": true,
	"protocolVersion": "0.4.1",
	"operation": ["custom_json", {
		"required_auths": [],
		"required_posting_auths": ["alice"],
		"id": "nftlox_testnet",
		"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.4.1\",\"action\":\"unlist\",\"data\":{\"nftId\":\"nft_a1b2c3d4e5f6\"}}"
	}],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.4.1",
		"action": "unlist",
		"data": {
			"nftId": "nft_a1b2c3d4e5f6"
		}
	}
}
```

### SDK usage

```typescript
import { buildUnlist } from "nftlox-sdk";

const result = await buildUnlist({
	owner: "alice",
	nftId: "nft_a1b2c3d4e5f6",
});

if (!result.success) {
	console.error(result.errors);
	return;
}

// result.operation -- sign with posting key and broadcast
```

### Validation rules (indexer)

- NFT must exist and be currently listed
- Signer must be the NFT owner

---

## 4. Payment Split Breakdown

Every purchase splits the total price into up to three transfers:

| Recipient | Percentage | Memo prefix | Description |
|---|---|---|---|
| **Seller** | Remainder after royalty + fee | `NFTLox BUY:` | Payment to the NFT owner |
| **Royalty recipient** | 0-50% (set by collection creator) | `NFTLox ROY:` | Creator royalty |
| **Fee account** | 1.0% (protocol fee) | `NFTLox FEE:` | Goes to the co-signing node |

### Calculation logic

All amounts are rounded to 3 decimal places (Hive precision).

```
feeAmount     = roundHive(totalPrice * 1.0 / 100)
royaltyAmount = roundHive(totalPrice * royaltyPct / 100)
sellerAmount  = totalPrice - royaltyAmount - feeAmount
```

### Edge cases

- **Royalty recipient is the seller:** royalty merges into the seller amount (no separate transfer)
- **Fee account is the seller:** fee merges into the seller amount (no separate transfer)
- **Zero royalty:** only 2 transfers (seller + fee)
- **All merges:** minimum 1 transfer (seller gets full amount)

### Example: 25 HIVE sale with 1% royalty

```
Total:   25.000 HIVE
Fee:      0.250 HIVE  (1.0%)  → nftlox       memo: "NFTLox FEE:nft_a1b2c3d4e5f6"
Royalty:  0.250 HIVE  (1.0%)  → artist        memo: "NFTLox ROY:nft_a1b2c3d4e5f6"
Seller:  24.500 HIVE          → alice          memo: "NFTLox BUY:nft_a1b2c3d4e5f6"
```

---

## 5. Memo Format Requirements

Each transfer in a buy transaction must include a structured memo. The format is strict -- the indexer verifies memos during both multisig validation and on-chain processing.

| Transfer type | Memo format | Example |
|---|---|---|
| Seller payment | `NFTLox BUY:{nftId}` | `NFTLox BUY:nft_a1b2c3d4e5f6` |
| Royalty payment | `NFTLox ROY:{nftId}` | `NFTLox ROY:nft_a1b2c3d4e5f6` |
| Protocol fee | `NFTLox FEE:{nftId}` | `NFTLox FEE:nft_a1b2c3d4e5f6` |

- Prefix and nftId are concatenated directly (no space after the colon)
- The nftId must match the NFT being purchased exactly
- Memos are validated by the multisig service before co-signing and by the indexer during on-chain processing

---

## 6. Buyer Protection via Multisig

The multisig flow exists to protect buyers. Here is why it matters and how it works:

### The problem without multisig

Without co-signing, a malicious seller could:

1. List an NFT for sale
2. Transfer it to an alt account while a buyer's transaction is in-flight
3. The buyer's HIVE transfer lands, but the NFT ownership was already moved

### How multisig solves this

The `custom_json` for a `buy` action uses `required_auths: [nodeAccount]` -- the node's active key is required to authorize it. This means:

1. **The buyer builds the transaction** with transfer operations (HIVE payments) and the `custom_json` (ownership change)
2. **The node validates everything** -- NFT is still listed, listing IDs match, payment amounts are correct, buyer is not the seller
3. **The node co-signs** only if validation passes -- returning its signature
4. **The buyer adds their signature** and broadcasts the complete transaction

Because both the HIVE transfers and the `custom_json` are in the **same atomic transaction**, either all operations succeed or none do. The node's signature on the `custom_json` guarantees:

- The NFT was verified as listed at the moment of signing
- Payment splits are mathematically correct
- The `listingId` and `listTxId` match the active listing (prevents stale/replayed listings)
- The transaction expires within 30-120 seconds (prevents signature reuse)

If the node rejects the transaction (returns `ok: false`), the buyer's funds **never leave their account** because the transaction is never broadcast.

### Transaction expiration

Multisig transactions must expire within 30-120 seconds (`MIN_EXPIRATION_MS` / `MAX_EXPIRATION_MS`). This tight window prevents:

- **Signature hoarding** -- a collected signature becomes useless quickly
- **State drift** -- the NFT state cannot change significantly within the window
- **Replay attacks** -- expired transactions are rejected by the Hive blockchain

---

## Querying Marketplace Listings

Use the indexer API to browse active listings. Each listed NFT includes `schema_version` and `owner_tx_id` in the response.

```bash
# All listings, sorted by price ascending
curl "https://api-nftlox.hivecreators.co/api/marketplace/listings?sort=price_asc&limit=20"

# Filter by currency
curl "https://api-nftlox.hivecreators.co/api/marketplace/listings?currency=HIVE&limit=20"
```

### SDK usage

```typescript
import { createIndexerClient } from "nftlox-sdk";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");

const listings = await client.getListings({
	sort: "price_asc",
	currency: "HIVE",
	limit: 20,
	offset: 0,
});

for (const nft of listings) {
	console.log(`${nft.name} — ${nft.listing_price} ${nft.listing_currency}`);
	// nft.schema_version -- schema version at time of last ownership change
	// nft.owner_tx_id -- transaction ID of the last ownership change
}
```

---

## Sales History and Volume

Completed sales are recorded in a `sales` table with the full financial split. Listing history is **not** stored locally -- it comes from the blockchain via HafAH when needed.

### GET /api/marketplace/sales

Returns completed sales with financial breakdown.

```bash
curl "https://api-nftlox.hivecreators.co/api/marketplace/sales?limit=20"
```

**Response fields per sale:**

| Field | Type | Description |
|---|---|---|
| `gross_amount` | number | Total sale price |
| `royalty_amount` | number | Royalty paid to creator |
| `protocol_fee` | number | Protocol fee (1%) |
| `seller_net` | number | Net amount received by the seller |
| `currency` | string | HIVE or HBD |
| `nft_id` | string | NFT identifier |
| `seller` | string | Seller account |
| `buyer` | string | Buyer account |

### GET /api/marketplace/volume

Returns aggregated marketplace volume statistics.

```bash
curl "https://api-nftlox.hivecreators.co/api/marketplace/volume"
```

---

## Listing Expiration

Listing expiration is **lazy** -- it is not detected by a background timer. Instead, an expired listing is detected when the NFT is touched by any operation: re-list, transfer, or buy attempt. When an expired listing is detected, the NFT status is auto-cleared back to `active` before the new operation proceeds.

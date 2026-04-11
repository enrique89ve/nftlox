# NFTLox Lending System

Peer-to-peer NFT lending. The lender retains ownership while the borrower gets temporary access. No collateral, no escrow -- the protocol enforces restrictions at the indexer level.

For general protocol operations, see [SDK Functions](sdk-functions.md). For broadcasting transactions, see [Broadcasting](broadcasting.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Lending an NFT (nft_lend)](#2-lending-an-nft-nft_lend)
3. [Returning an NFT (nft_return)](#3-returning-an-nft-nft_return)
4. [Status Restrictions](#4-status-restrictions)
5. [API Endpoints](#5-api-endpoints)
6. [SDK Builder Examples](#6-sdk-builder-examples)
7. [Use Cases](#7-use-cases)

---

## 1. Overview

The lending system introduces two operations:

| Action       | Description                        | Who can call      |
|--------------|------------------------------------|-------------------|
| `nft_lend`   | Lend an NFT to a borrower          | NFT owner         |
| `nft_return` | Return a lent NFT back to owner    | Lender or borrower |

When an NFT is lent:

- Its status changes from `active` to `lent`.
- A loan record is created in the `nft_loans` table (lender, borrower, operation, block, tx).
- All existing NFT approvals are cleared.
- The borrower **cannot** transfer, list, burn, or approve the NFT.
- Ownership does **not** change -- the lender remains the on-chain owner.

When an NFT is returned:

- Its status reverts to `active`.
- The loan record is deleted.

---

## 2. Lending an NFT (nft_lend)

### Preconditions

- NFT must exist and have status `active`.
- NFT must be an **instance** (seeds cannot be lent).
- Signer must be the NFT owner.
- Borrower must differ from the owner.
- Collection must be `transferable` (non-transferable collections block lending).
- No existing loan on the NFT.

### Protocol Payload

```json
{
	"protocol": "nftlox_testnet",
	"version": "0.4.1",
	"action": "nft_lend",
	"data": {
		"instanceId": "inst_abc123",
		"borrower": "bob"
	}
}
```

### What the Indexer Does

1. Validates the NFT exists, is `active`, is an instance, and the signer is the owner.
2. Checks the collection allows transfers.
3. Checks no existing loan exists.
4. Sets NFT status to `lent`.
5. Inserts a row into `nft_loans` with `lender`, `borrower`, `operation_id`, `block_num`, and `tx_id`.
6. Deletes any existing NFT allowances (approvals are cleared).

---

## 3. Returning an NFT (nft_return)

### Preconditions

- NFT must exist and have status `lent`.
- An active loan record must exist.
- Signer must be either the **lender** or the **borrower**.

### Protocol Payload

```json
{
	"protocol": "nftlox_testnet",
	"version": "0.4.1",
	"action": "nft_return",
	"data": {
		"instanceId": "inst_abc123"
	}
}
```

### What the Indexer Does

1. Validates the NFT exists and has status `lent`.
2. Loads the loan record and verifies the signer is the lender or borrower.
3. Sets NFT status back to `active`.
4. Deletes the loan record.

Either party can return the NFT at any time. There is no expiration -- the lender can reclaim their NFT whenever they choose, and the borrower can return it voluntarily.

---

## 4. Status Restrictions

While an NFT has status `lent`, the following operations are blocked by the indexer:

| Operation          | Blocked? | Check                  |
|--------------------|----------|------------------------|
| `transfer`         | Yes      | `assertTransferable()` |
| `list`             | Yes      | `assertNotLent()`      |
| `buy`              | Yes      | `assertNotLent()`      |
| `burn`             | Yes      | `assertNotLent()`      |
| `nft_approve`      | Yes      | `assertNotLent()`      |
| `bulk_distribute`  | Yes      | `assertNotLent()`      |
| `pack_open` (seed) | Yes      | `assertNotLent()`      |
| `set_data`         | No       | Creator can still update mutable data |
| `set_owner_data`   | No       | Owner can still update owner data     |
| `nft_return`       | No       | This is how you unlock it             |

Additionally, when an NFT is lent, all existing approvals (allowances) are deleted. This prevents a pre-approved spender from transferring a lent NFT.

---

## 5. API Endpoints

### GET /api/users/:username/loans

List active loans for a user.

```bash
curl "https://api-nftlox.hivecreators.co/api/users/alice/loans?role=lender"
curl "https://api-nftlox.hivecreators.co/api/users/bob/loans?role=borrower"
```

`role=lender` returns NFTs the user has lent out. `role=borrower` returns NFTs temporarily usable by the user. `role=all` returns both.

### GET /api/nfts/:id/loan

Return active loan custody for one NFT.

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/inst_abc123/loan
```

The response includes `loan_operation_id`, which can be resolved through HAFAH. This route does not change or redefine the NFT owner.

### POST /api/build/nft-lend

Build an unsigned `nft_lend` operation.

**Request:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/nft-lend \
	-H "Content-Type: application/json" \
	-d '{
		"owner": "alice",
		"instanceId": "inst_abc123",
		"borrower": "bob"
	}'
```

**Request Body:**

| Field        | Type     | Required | Description                                       |
|--------------|----------|----------|---------------------------------------------------|
| `owner`      | `string` | Yes      | Hive username of the NFT owner (lender).          |
| `instanceId` | `string` | Yes      | NFT instance ID to lend.                          |
| `borrower`   | `string` | Yes      | Hive username of the borrower. Must differ from owner. |
| `seedId`     | `string` | No       | Seed provenance ID.                               |
| `seedTxId`   | `string` | No       | Seed parent's tx_id (for L1 traceability).        |

**Key type:** Posting

**Response (success):**

```json
{
	"success": true,
	"protocolVersion": "0.4.1",
	"operation": [
		"custom_json",
		{
			"required_auths": [],
			"required_posting_auths": ["alice"],
			"id": "nftlox_testnet",
			"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.4.1\",\"action\":\"nft_lend\",\"data\":{\"instanceId\":\"inst_abc123\",\"borrower\":\"bob\"}}"
		}
	],
	"keyType": "Posting"
}
```

**Response (error):**

```json
{
	"success": false,
	"errors": [
		{ "field": "borrower", "message": "Cannot lend to yourself", "code": "LEND_TO_SELF" }
	]
}
```

---

### POST /api/build/nft-return

Build an unsigned `nft_return` operation.

**Request:**

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/nft-return \
	-H "Content-Type: application/json" \
	-d '{
		"signer": "bob",
		"instanceId": "inst_abc123"
	}'
```

**Request Body:**

| Field        | Type     | Required | Description                                       |
|--------------|----------|----------|---------------------------------------------------|
| `signer`     | `string` | Yes      | Hive username of the signer (borrower or owner).  |
| `instanceId` | `string` | Yes      | NFT instance ID to return.                        |
| `seedId`     | `string` | No       | Seed provenance ID.                               |
| `seedTxId`   | `string` | No       | Seed parent's tx_id (for L1 traceability).        |

Note: The `signer` field in the request body maps to `owner` internally.

**Key type:** Posting

**Response (success):**

```json
{
	"success": true,
	"protocolVersion": "0.4.1",
	"operation": [
		"custom_json",
		{
			"required_auths": [],
			"required_posting_auths": ["bob"],
			"id": "nftlox_testnet",
			"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.4.1\",\"action\":\"nft_return\",\"data\":{\"instanceId\":\"inst_abc123\"}}"
		}
	],
	"keyType": "Posting"
}
```

---

## 6. SDK Builder Examples

### Lend an NFT

```typescript
import { buildNftLend } from "nftlox-sdk";

const result = buildNftLend({
	owner: "alice",
	instanceId: "inst_abc123",
	borrower: "bob",
});

if (!result.success) {
	console.error(result.errors);
	// → [{ field: "borrower", message: "Cannot lend to yourself", code: "LEND_TO_SELF" }]
} else {
	console.log(result.operation);
	// → ["custom_json", { required_posting_auths: ["alice"], ... }]
}
```

### Return a Lent NFT

```typescript
import { buildNftReturn } from "nftlox-sdk";

// Borrower returns
const result = buildNftReturn({
	owner: "bob",
	instanceId: "inst_abc123",
});

if (result.success) {
	console.log(result.operation);
	// → ["custom_json", { required_posting_auths: ["bob"], ... }]
}
```

### Using Payload Creators Directly

```typescript
import { createNftLendPayload, createNftReturnPayload } from "nftlox-sdk";

// Lend
const lendPayload = createNftLendPayload({
	instanceId: "inst_abc123",
	borrower: "bob",
});
// → { protocol: "nftlox_testnet", version: "0.4.1", action: "nft_lend", data: { instanceId: "inst_abc123", borrower: "bob" } }

// Return
const returnPayload = createNftReturnPayload({
	instanceId: "inst_abc123",
});
// → { protocol: "nftlox_testnet", version: "0.4.1", action: "nft_return", data: { instanceId: "inst_abc123" } }
```

### Using Operation Creators

```typescript
import { createNftLendOperation, createNftReturnOperation } from "nftlox-sdk";

// Lend operation (owner signs with posting key)
const lendOp = createNftLendOperation(
	{ instanceId: "inst_abc123", borrower: "bob" },
	"alice",
);

// Return operation (either party signs)
const returnOp = createNftReturnOperation(
	{ instanceId: "inst_abc123" },
	"bob",
);
```

---

## 7. Use Cases

### Game Tournaments

A player lends their best card to a friend for a tournament. The card's mutable game data (XP, level) can still be updated by the game server via `set_data`, but the borrower cannot transfer or sell the card.

```typescript
// Before the tournament
buildNftLend({ owner: "alice", instanceId: "card_001", borrower: "bob" });

// After the tournament
buildNftReturn({ owner: "bob", instanceId: "card_001" });
```

### Try-Before-You-Buy

A seller lends an NFT to a potential buyer so they can inspect it in-game. If the buyer likes it, the seller reclaims it and lists it for sale.

```typescript
// Lend for inspection
buildNftLend({ owner: "seller", instanceId: "item_xyz", borrower: "buyer" });

// Buyer decides to buy -- seller reclaims first
buildNftReturn({ owner: "seller", instanceId: "item_xyz" });

// Now seller can list it
buildList({ owner: "seller", nftId: "item_xyz", price: "10.000 HIVE" });
```

### Guild Lending

A guild leader lends equipment NFTs to guild members. Since only the lender or borrower can return, the guild leader can reclaim items from inactive members at any time.

```typescript
// Guild leader distributes gear
buildNftLend({ owner: "guildmaster", instanceId: "sword_01", borrower: "member1" });
buildNftLend({ owner: "guildmaster", instanceId: "shield_02", borrower: "member2" });

// Reclaim from inactive member
buildNftReturn({ owner: "guildmaster", instanceId: "sword_01" });
```

---

## Database Schema

The `nft_loans` table tracks active loans:

```sql
CREATE TABLE IF NOT EXISTS nft_loans (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id),
	lender TEXT NOT NULL,
	borrower TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`operation_id` is the HafAH operation anchor for the active lend operation. `block_num` and `tx_id` remain useful context, but `operation_id` is the precise identifier when one Hive transaction contains multiple NFTLox `custom_json` operations.

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_nft_loans_lender ON nft_loans(lender);
CREATE INDEX IF NOT EXISTS idx_nft_loans_borrower ON nft_loans(borrower);
```

An NFT can only have one active loan at a time (enforced by the `PRIMARY KEY` on `nft_id`).

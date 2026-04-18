# NFT Lending

Non-custodial, escrow-free NFT lending for instances. The lender keeps ownership; the borrower gets a scoped right to use the NFT until they return it. The protocol guarantees the lender can always reclaim — there is no collateral, no time lock, no liquidation.

Lending applies only to **instances**. Seeds are templates and cannot be lent.

## State model

A lent instance has exactly two on-chain properties that differ from a plain owned instance:

- `status = "lent"`
- `loan` row with `{ lender, borrower, loan_tx_id, loan_block_num, … }`

While `status = "lent"`:

- **Ownership does not transfer.** `client.getNftOwner(id)` keeps returning the lender.
- **Transfers are blocked.** `transfer`, `nft_transfer_from`, `buy` → rejected.
- **Listings are blocked.** `list` → rejected.
- **Approvals are frozen.** New `nft_approve`/`nft_approve_all` cannot be created; existing ones cannot be acted on.
- **Mutable data writes remain allowed** (for both owner and approved operators). Games want borrowers to accumulate XP on a rented card.

Only `nft_return` (called by the current borrower) can exit the `lent` state.

## Lending — `buildNftLend`

```typescript
import { buildNftLend } from "nftlox-sdk";
import hive from "hive-tx";

hive.config.set("node", "https://api.hive.blog");

const result = buildNftLend({
	owner: "alice",
	instanceId: "nft_abc…_7",
	borrower: "bob",                // must differ from owner
});
if (!result.success) throw new Error(JSON.stringify(result.errors));

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.sign(hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!));
await tx.broadcast();
```

`owner === borrower` is rejected by the builder with code `LEND_TO_SELF`. Lending an already-lent NFT is rejected by the indexer (`NFT_LOCKED`).

## Returning — `buildNftReturn`

Signed by the **current borrower**, not the lender. This is the only way the lender regains active control.

```typescript
import { buildNftReturn } from "nftlox-sdk";

const result = buildNftReturn({
	owner: "bob",                   // the borrower returning it
	instanceId: "nft_abc…_7",
});
if (!result.success) throw new Error(JSON.stringify(result.errors));
// sign with Bob's posting key, broadcast
```

After the return lands, `status` flips back to `active` and all normal actions (transfer, list, approve) resume for the lender.

## Querying loan state

```typescript
const client = createIndexerClient(INDEXER);

// Status of a specific NFT
const loanStatus = await client.getNftLoan("nft_…");
// { nft_id, active: true | false, loan: IndexerNftLoan | null }

// Everything a user is currently lending or borrowing
const lending = await client.getUserLoans("alice", { role: "lender" });
const borrowing = await client.getUserLoans("bob", { role: "borrower" });
const all = await client.getUserLoans("alice", { role: "all" });
```

`IndexerNftLoan` carries the originating tx_id, block number, and the lender/borrower pair. Use it for UI rendering, dispute timestamps, or off-chain rental-contract bookkeeping.

## Designing around lending

The protocol gives you a safe primitive. Pricing, duration, and reputation are up to your app.

Typical patterns:

- **Free rentals for guilds.** Social trust, no off-chain contract. Lender can reclaim any time; borrower is expected to return on request.
- **Paid rentals via off-chain contract.** Borrower pays in HIVE/HBD upfront; your backend records the rental period and automatically calls `nft_return` if the borrower forgets. Because the lender can reclaim at any moment regardless of contract, your off-chain terms can include a penalty clause for early reclaim.
- **Tournament whitelist.** Lend a legendary card to a teammate for the weekend; the card keeps earning XP under the borrower, which all ends up on the owner's NFT after return.

What the protocol **doesn't** give you:

- **Duration enforcement.** The lender can reclaim at any time by simply asking the borrower to return, or by waiting (the borrower cannot transfer or sell). If you need hard-time-lock lending, layer it off-chain with a payment that is refunded on successful return.
- **Automatic payments.** Charge the borrower off-chain; the chain only tracks the NFT state.
- **Dispute resolution.** If a borrower refuses to return, the lender's remedy is social (reputation) and legal (off-chain contract), not protocol-level.

## Interactions with approvals

An NFT that is currently lent **cannot** be the subject of a new `nft_approve` or be transferred by an existing `nft_approve_all`. When you return the NFT, your prior approvals are still in place — approvals outlive lending, they just can't be acted on during it.

## Failure modes

| Broadcast rejection | Cause |
|---|---|
| `LEND_TO_SELF` | Builder: `owner === borrower`. |
| `NFT_LOCKED` | Indexer: instance is already lent, or in-flight on another lock (buy, transfer). |
| `NFT_NOT_INSTANCE` | Trying to lend a seed. |
| Builder `ValidationError` | Missing `instanceId`, invalid Hive usernames. |

On broadcast failure, poll `getOperationStatus(txId)` — the indexer populates `reason` on `invalid` ops.

## See also

- [Data Formats — `nft_lend`, `nft_return`](../data-formats.md#nft_lend)
- [SDK Reference — lending builders](../sdk/reference.md#lending)
- [Allowances & Operators](allowances.md) — why approvals and lending coexist without conflict.

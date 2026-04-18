# Allowances & Operators

NFTLox ships two separate delegation systems. Both run entirely on posting auth — you never need to hand out your active key to authorize automated flows.

| System | Grantor | Scope | What the delegate can do |
|---|---|---|---|
| **Instance approval** (`nft_approve`) | Instance owner | Single instance | Call `nft_transfer_from` on that one instance. |
| **Collection-wide approval** (`nft_approve_all`) | Instance owner | All instances of a collection they own (including future acquisitions) | Call `nft_transfer_from` on any of them. |
| **Data operator** (`data_operator_approve`) | Collection creator | Mutable data writes across the whole collection | Call `set_data_from` on any instance in the collection. |

Seeds are templates, not tradable assets — `nft_approve` and `nft_approve_all` operate on **instances** only.

## Instance approval — `buildNftApprove`

```typescript
import { buildNftApprove } from "nftlox-sdk";

const result = buildNftApprove({
	owner: "alice",
	instanceId: "nft_abcdef…_7",
	spender: "marketplace-contract",
	approved: true,
});
```

Scope: exactly one instance. Revoke with `approved: false`. The approval is consumed by the first `nft_transfer_from` that references it — you can re-approve to allow a second transfer.

## Collection-wide approval — `buildNftApproveAll`

```typescript
import { buildNftApproveAll } from "nftlox-sdk";

const result = buildNftApproveAll({
	owner: "alice",
	collectionId: "col_…",
	spender: "marketplace",
	approved: true,
});
```

Scope: every instance Alice **currently owns or will ever own** in that collection. The approval survives buys, transfers, and lending returns — it only ends when Alice broadcasts `approved: false` or burns each instance.

## Operator-initiated transfer — `buildNftTransferFrom`

Called by the spender, not the owner. The spender's posting key is the only signature needed.

```typescript
import { buildNftTransferFrom } from "nftlox-sdk";

const result = buildNftTransferFrom({
	operator: "marketplace",
	from: "alice",
	to: "bob",
	instanceId: "nft_abcdef…_7",
});
```

Rejection conditions:
- Operator is not approved for this instance (neither `nft_approve` nor `nft_approve_all` matches).
- Instance is currently lent (lending locks `nft_transfer_from`).
- Instance is currently listed (unlist first, or let the listing expire).

## Data operators — `buildDataOperatorApprove`

Only the **collection creator** can grant this. The scope is mutable-data writes across the whole collection — useful for game servers that need to update `xp`, `wins`, `level`, etc. without ever holding player keys.

```typescript
import { buildDataOperatorApprove } from "nftlox-sdk";

const result = buildDataOperatorApprove({
	creator: "ragnarok-studio",      // must match the collection's creator
	collectionId: "col_…",
	operator: "ragnarok-server",
	approved: true,
});
```

Once approved, the operator uses `buildSetDataFrom` to update mutable data on any instance in the collection:

```typescript
import { buildSetDataFrom } from "nftlox-sdk";

const result = buildSetDataFrom({
	operator: "ragnarok-server",
	nftId: "nft_…",
	instanceDna: nft.instance_dna,
	mutableData: { xp: 5000, level: 12 },
});
```

Revoke any time with `approved: false`. The revocation is effective from the next block onward; writes already broadcast and pending finalization complete normally.

## Security boundary

What operators **cannot** do:

- Write to `immutableData` (it is frozen at mint time for every NFT).
- Change ownership via `set_data_from` (`nft_transfer_from` is the only transfer path, which data operators don't have).
- Override the collection schema (only the creator can `extend_schema`).
- Self-grant — a data-operator approval must be broadcast by the creator.
- Bypass lending or listing locks — all normal state guards still apply.

What they **can** do (and why it's fine):

- Rewrite mutable stats to any value the schema allows. This is the whole point of the delegation; trust the operator the way players trust your game server.
- Continue operating after the creator goes offline, until the creator revokes.

If you are designing a permissionless marketplace contract, prefer `nft_approve_all` so users opt in once. If you are designing a game server, prefer `data_operator_approve` so players opt in via the game (no wallet dance) while still retaining ownership and transfer rights.

## Reading approvals from the indexer

Approvals are materialized as plain indexer rows — no extra endpoint needed. A future version of the SDK/client will expose typed helpers; today you can query the raw ownership + operation logs:

```typescript
await client.getUserNfts("alice", { status: "active" });    // ownership stays with Alice
await client.getOperationStatus(approveTxId);                // confirm the approval landed
```

## See also

- [Mutable Data](../examples/mutable-data.md) — end-to-end pattern for operator-driven stat updates.
- [Data Formats — `nft_approve`, `nft_approve_all`, `nft_transfer_from`, `data_operator_approve`, `set_data_from`](../data-formats.md)
- [SDK Reference — approval builders](../sdk/reference.md#approvals--delegation)

# Allowances & Operators

NFTLox ships two separate delegation systems. Granting or using ownership
delegation requires active auth; mutable-data delegation remains posting-only.
Never hand an active key to an automated data operator.

| System | Grantor | Scope | What the delegate can do |
|---|---|---|---|
| **Instance approval** (`asset_approve`) | Instance owner | Single instance | Call `asset_transfer_from` on that one instance. |
| **Collection-wide approval** (`asset_approve_all`) | Instance owner | All instances of a collection they own while the approval remains active | Call `asset_transfer_from` on any of them. |
| **Data operator** (`data_operator_approve`) | Collection creator | Mutable data writes across the whole collection | Call `set_data_from` on any instance in the collection. |

Seeds are templates, not tradable assets — `asset_approve` and `asset_approve_all` operate on **instances** only.

## Instance approval — `buildAssetApprove`

```typescript
import { buildAssetApprove } from "nftlox-sdk";

const result = buildAssetApprove({
	owner: "alice",
	instanceId: "asset_abcdef…_7",
	spender: "marketplace-contract",
	approved: true,
});
```

Scope: exactly one instance. Revoke with `approved: false`. The approval is consumed by the first `asset_transfer_from` that references it — you can re-approve to allow a second transfer.

## Collection-wide approval — `buildAssetApproveAll`

```typescript
import { buildAssetApproveAll } from "nftlox-sdk";

const result = buildAssetApproveAll({
	owner: "alice",
	collectionId: "col_…",
	spender: "marketplace",
	approved: true,
});
```

Scope: every instance Alice owns in that collection while the approval remains active. The approval also covers instances Alice receives later, but it is automatically removed if Alice's holdings in that collection drop to zero through `transfer`, `buy`, `burn`, or `asset_transfer_from`. Alice can revoke it at any time by broadcasting `approved: false`. See [Protocol Invariants](../concepts/protocol-invariants.md#collection-approvals) for the approval lifecycle rule.

## Operator-initiated transfer — `buildAssetTransferFrom`

Called by the spender, not the owner. The spender's active key is the required signature.

```typescript
import { buildAssetTransferFrom } from "nftlox-sdk";

const result = buildAssetTransferFrom({
	operator: "marketplace",
	from: "alice",
	to: "bob",
	instanceId: "asset_abcdef…_7",
});
```

Rejection conditions:
- Operator is not approved for this instance (neither `asset_approve` nor `asset_approve_all` matches).
- Instance is currently lent (lending locks `asset_transfer_from`).
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
	assetId: "asset_…",
	assetDna: asset.asset_dna,
	mutableData: { xp: 5000, level: 12 },
});
```

Revoke any time with `approved: false`. The revocation is effective from the next block onward; writes already broadcast and pending finalization complete normally.

## Security boundary

What operators **cannot** do:

- Write to `immutableData` (it is frozen at mint time for every Asset).
- Change ownership via `set_data_from` (`asset_transfer_from` is the only transfer path, which data operators don't have).
- Override the collection schema (only the creator can `extend_schema`).
- Self-grant — a data-operator approval must be broadcast by the creator.
- Bypass lending or listing locks — all normal state guards still apply.

What they **can** do (and why it's fine):

- Rewrite mutable stats to any value the schema allows. This is the whole point of the delegation; trust the operator the way players trust your game server.
- Continue operating after the creator goes offline, until the creator revokes.

If you are designing a permissionless marketplace contract, prefer `asset_approve_all` so users opt in once. If you are designing a game server, prefer `data_operator_approve` so players opt in via the game (no wallet dance) while still retaining ownership and transfer rights.

## Reading approvals from the indexer

Approvals are materialized as plain indexer rows — no extra endpoint needed. A future version of the SDK/client will expose typed helpers; today you can query the raw ownership + operation logs:

```typescript
await client.getUserAssets("alice", { status: "active" });    // ownership stays with Alice
await client.getOperationStatus(approveTxId);                // confirm the approval landed
```

## See also

- [Mutable Data](../use-cases/mutable-data.md) — end-to-end pattern for operator-driven stat updates.
- [Data Formats — `asset_approve`, `asset_approve_all`, `asset_transfer_from`, `data_operator_approve`, `set_data_from`](../data-formats.md)
- [SDK Reference — approval builders](../sdk/reference.md#approvals--delegation)

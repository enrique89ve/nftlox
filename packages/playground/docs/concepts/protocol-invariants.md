# Protocol Invariants

This page is the public reasoning model for NFTLox state transitions. It exists so protocol changes can be reviewed against explicit rules instead of handler-by-handler intuition.

Every accepted operation must preserve these invariants.

---

## Authority

The signer is derived from the Hive `custom_json` authority, not from a payload field.

| Invariant | Rule |
|---|---|
| A1 | A protocol action can only act for the account in `required_auths` or `required_posting_auths`. |
| A2 | Owner-scoped actions use `op.signer` as the owner authority. |
| A3 | Operator-scoped actions use `op.signer` as the delegated operator and must prove an existing approval. |
| A4 | Payload fields can identify targets, but they cannot grant authority by themselves. |

Examples:

- `nft_approve_all` stores `owner = op.signer`; the payload does not contain an owner field.
- `nft_transfer_from` accepts `from` in the payload, but it still requires `op.signer` to match an instance or collection approval from that owner.
- `create_collection` and `buy` require active authority because they are node-cosigned flows with native-token consequences.

---

## Ownership

`nfts.owner` is the current owner. It changes only through ownership-changing actions.

| Action | Ownership effect |
|---|---|
| `mint` | Creates a seed and sets its initial owner. |
| `bulk_distribute` | Creates instances and sets their initial owner. |
| `transfer` | Moves ownership from the signer to another account, or burns via `to = "null"`. |
| `nft_transfer_from` | Moves ownership through an instance or collection approval. |
| `buy` | Moves ownership after marketplace settlement. |
| `list`, `unlist` | Do not change owner. |
| `nft_lend`, `nft_return` | Do not change owner. They change use/custody state only. |

Each ownership change updates the current owner anchor:

- `previous_owner`
- `owner_action`
- `owner_operation_id`
- `owner_block_num`

Creation anchors stay fixed.

---

## Collection Approvals

`nft_approve_all` is collection-scoped transfer authority for the current owner while the approval remains active.

| Invariant | Rule |
|---|---|
| C1 | `approved: true` requires the signer to own at least one NFT in the collection. |
| C2 | A collection approval covers all current NFTs the owner has in that collection. |
| C3 | Future acquisitions are covered only while the approval row remains active. |
| C4 | The approval is automatically removed when the owner has zero NFTs left in the collection. |
| C5 | The zero-holdings cleanup must run no matter which action emptied the owner: `transfer`, `buy`, `burn`, or `nft_transfer_from`. |

This avoids zombie approvals: a delegated spender cannot empty an owner's collection and keep hidden transfer authority for a later reacquisition.

Instance approvals are narrower:

- `nft_approve` applies to one instance.
- It is cleared when ownership changes, the NFT is burned, bought, transferred, lent, or moved through `nft_transfer_from`.

---

## Listings

Listings are exclusive with ownership-changing and lending flows.

| Invariant | Rule |
|---|---|
| L1 | Active listings block direct ownership and custody changes such as `transfer`, `nft_transfer_from`, `burn`, and `nft_lend`. |
| L2 | `buy` requires a valid active listing; expired or effective-unlisted listings cannot settle. |
| L3 | Expired listings may be replaced or cleared by the action that proves they are expired. |
| L4 | `unlist` stamps `pending_unlist_block` and leaves the NFT listed until the delay window materializes. |
| L5 | Any action that changes ownership or creates a fresh listing must clear stale `pending_unlist_block`. |
| L6 | `collection_stats.listed` changes exactly once for each listed-to-active or active-to-listed transition. |

The pending-unlist delay protects multisig buys already in flight while still giving the owner a deterministic exit.

---

## Seeds And Instances

Seeds are templates. Instances are tradable assets created from seeds.

| Invariant | Rule |
|---|---|
| S1 | `mint` creates seeds only. |
| S2 | `bulk_distribute` creates instances only. |
| S3 | Only the current seed owner can distribute from that seed. |
| S4 | A seed with distributed instances cannot change ownership, be listed, be delegated, or be lent. |
| S5 | Instance provenance is anchored by `seed_id` and creation operation fields, not by the seed's later owner. |

---

## Data Operators

Data delegation and transfer delegation are separate systems.

| Invariant | Rule |
|---|---|
| D1 | `data_operator_approve` grants mutable-data write authority, not transfer authority. |
| D2 | `nft_approve` and `nft_approve_all` grant transfer authority, not mutable-data authority. |
| D3 | `set_data_from` requires a collection data operator and cannot change ownership. |

Games should prefer `data_operator_approve` when the server only needs to update gameplay data.

---

## Review Checklist

Before adding or changing a handler, verify:

- The signer role is derived from Hive authority and matches the action's role.
- Ownership-changing actions update owner anchors and clear stale listing fields.
- Any action that can empty an owner's collection runs collection-approval cleanup after the owner count actually reaches zero.
- Listing status and `collection_stats.listed` move together.
- Instance approvals do not survive ownership changes or destructive state changes.
- Data operator permissions never imply transfer rights.
- Seed distribution locks are preserved.

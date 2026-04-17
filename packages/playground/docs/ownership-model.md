# Ownership Model

NFTLox separates collection authority, seed custody, instance origin, and current ownership. The protocol stores only the fields needed to reconstruct those relationships deterministically from Hive L1.

---

## Core Flow

```text
create_collection
  -> mint seed
  -> bulk_distribute instances from seed
  -> transfer / buy / nft_transfer_from instances between owners
```

`mint` creates seeds only. Instances are created by `bulk_distribute`.

---

## Roles

| Concept | Source of truth | Changes? | Meaning |
|---|---|---|---|
| Collection creator | `collections.creator` | No | Account that created the collection and controls schema-level authority |
| Seed creator | Inherited from `collections.creator` through `mint` authorization | No | The collection creator is the only account allowed to mint seeds |
| Seed owner | `nfts.owner` where `nft_type = "seed"` | Yes, before distribution lock | Current custodian of the seed and the only account allowed to distribute from it |
| Instance origin | `nfts.seed_id` | No | Parent seed that gives the instance its art identity and immutable data |
| Instance distributor | `nfts.created_operation_id -> confirmed_operations.signer` | No | Account that created the instance through `bulk_distribute` |
| Instance owner | `nfts.owner` where `nft_type = "instance"` | Yes | Current owner of the instance |
| Previous owner | `nfts.previous_owner` | Yes | Owner immediately before the latest ownership change |

---

## Seed Rules

Seeds are the master assets of a collection.

- A seed is created with `mint`.
- The signer of `mint` must be the collection creator.
- A seed can be minted directly to the creator or to another owner through the optional `owner` field.
- The current seed owner is the only account allowed to call `bulk_distribute`.
- The collection creator does not keep distribution rights after transferring a seed to another owner.
- Once a seed has distributed instances (`distributed > 0`), it is locked from ownership-changing flows so existing instance provenance remains coherent.

---

## Instance Rules

Instances are copies created from a seed.

- An instance is created with `bulk_distribute`, never with `mint`.
- The instance stores `seed_id` and `instance_number`.
- The instance inherits art identity, base metadata, and immutable data from the parent seed.
- The instance does not need a separate `created_by` column for product identity because its origin is the seed.
- The historical distributor is still auditable through the instance creation anchor:

```text
instance.created_operation_id
  -> confirmed_operations.operation_id
  -> confirmed_operations.signer
```

Do not infer the creator of an old instance from the seed's current owner. Seed ownership can change after an instance was distributed.

---

## Ownership Changes

`owner` is the current owner field. It changes only when ownership changes.

| Action | Changes owner? | Notes |
|---|---:|---|
| `mint` | Yes | Sets the initial seed owner |
| `bulk_distribute` | Yes | Sets the initial instance owner to `to` or signer |
| `transfer` | Yes | Moves current ownership |
| `nft_transfer_from` | Yes | Moves current ownership through approval |
| `buy` | Yes | Moves ownership after marketplace settlement |
| `list` | No | Only changes listing state |
| `unlist` | No | Only clears listing state |
| `nft_lend` | No | Changes custody, not ownership |
| `nft_return` | No | Ends loan custody, not ownership |

On each ownership change, the indexer updates:

- `owner`
- `previous_owner`
- `owner_action`
- `owner_operation_id`
- `owner_block_num`

`previous_owner` is only the latest edge. NFTLox does not store a full owner history table because the canonical history is on Hive L1.

---

## Provenance Anchors

Each NFT has two different anchor groups:

| Field | Purpose |
|---|---|
| `created_operation_id` | Operation that created the seed or instance |
| `created_block_num` | Block where the seed or instance was created |
| `created_tx_id` | Hive transaction where the seed or instance was created |
| `owner_operation_id` | Operation that established the current owner |
| `owner_action` | Protocol action that established the current owner |
| `owner_block_num` | Block where the current owner was established |

For a newly created NFT, the creation anchor and owner anchor point to the same operation. After a transfer, sale, or approved transfer, the creation anchor stays fixed while the owner anchor moves forward.

---

## Practical Interpretation

Use these fields depending on the product question:

| Question | Field or derivation |
|---|---|
| Who created the collection? | `collections.creator` |
| Who created the seed? | `collections.creator` via the seed's collection |
| Who can distribute new instances now? | Current `owner` of the seed |
| Where did this instance come from? | `seed_id` |
| Who distributed this instance historically? | `created_operation_id -> confirmed_operations.signer` |
| Who owns this instance now? | Current `owner` of the instance |
| Who owned it immediately before? | `previous_owner` |
| Which L1 operation proves current ownership? | `owner_operation_id` |

This is why NFTLox does not require additional `seed_creator`, `instance_creator`, or `created_by` columns for the current model.

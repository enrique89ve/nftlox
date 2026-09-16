# Protocol operations

This is the SDK-facing summary of the canonical action set. The wire contract
and validation rules remain in [`@nftlox/protocol`](../protocol/README.md).

| # | Action | Authority | Summary |
|---:|---|---|---|
| 1 | `create_collection` | Active | Create a collection |
| 2 | `mint` | Posting | Mint a seed NFT |
| 3 | `transfer` | Active | Transfer or directly burn Assets |
| 4 | `bulk_distribute` | Posting | Create instances from seeds |
| 5 | `set_data` | Posting | Update owner-controlled mutable data |
| 6 | `extend_schema` | Posting | Extend a collection schema |
| 7 | `archive_collection` | Posting | Archive an empty collection |
| 8 | `node_register` | Posting | Register an indexer node |
| 9 | `node_heartbeat` | Posting | Publish node liveness and sync state |
| 10 | `node_state_checkpoint` | Posting | Publish an ownership state checkpoint |
| 11 | `list` | Active | List an instance for sale |
| 12 | `unlist` | Active | Remove an instance listing |
| 13 | `buy_commitment` | Active | Reserve a listing by settlement-node commitment |
| 14 | `buy` | Active | Settle a listed instance |
| 15 | `asset_approve` | Active | Approve one instance spender |
| 16 | `asset_approve_all` | Active | Approve a collection-wide spender |
| 17 | `asset_transfer_from` | Active | Transfer an instance using prior approval |
| 18 | `asset_lend` | Active | Lend an instance without changing ownership |
| 19 | `asset_return` | Active | Return a lent instance |
| 20 | `data_operator_approve` | Posting | Approve a mutable-data operator |
| 21 | `set_data_from` | Posting | Update data through an approved operator |

Delegated transfers are ordinary ownership transfers only. The reserved burn
account `null` is rejected by `asset_transfer_from`; burning is available only
through the owner's direct `transfer` action when the collection is burnable.

For payload examples and builder return types, see [Data Formats](../playground/docs/data-formats.md)
and the [SDK Reference](../playground/docs/sdk/reference.md).

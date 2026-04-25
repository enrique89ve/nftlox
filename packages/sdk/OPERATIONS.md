# NFTLox Protocol Operations Catalog v0.6.2

Complete reference for SDK-owned protocol operations. Each operation is broadcast as a `custom_json` on the Hive blockchain with `id = "nftlox_testnet"`.

---

## Summary

| # | Action | Category | Key | Description |
|---|--------|----------|-----|-------------|
| 1 | `create_collection` | Core | active | Creates a collection (node-cosigned with fee transfer) |
| 2 | `mint` | Core | posting | Creates a seed NFT within a collection |
| 3 | `transfer` | Core | posting | Transfers ownership of an NFT |
| 4 | `bulk_distribute` | Core | posting | Mints multiple instances from seeds |
| 5 | `set_data` | Core | posting | Creator updates mutable data of an NFT (requires schema) |
| 6 | `extend_schema` | Core | posting | Creator adds fields to a collection schema |
| 7 | `archive_collection` | Core | posting | Archives an empty collection |
| 8 | `node_register` | Core | posting | Opt-in listing in the public `l2_nodes` directory (≥100 HP) |
| 9 | `node_heartbeat` | Core | posting | Periodic proof-of-liveness + ownership state-root hash |
| 10 | `node_state_checkpoint` | Core | posting | Periodic state-root snapshot at fixed block boundaries (every 1000 blocks) |
| 11 | `list` | Marketplace | posting | Lists an NFT for sale |
| 12 | `unlist` | Marketplace | posting | Removes an NFT from the marketplace |
| 13 | `buy_commitment` | Marketplace | active | Node-broadcast reservation that wins the cross-node ordering race before the node co-signs a `buy` |
| 14 | `buy` | Marketplace | active | Settles a reserved listing (buyer-signed transfers + node-cosigned custom_json, must match the preceding `buy_commitment`) |
| 15 | `nft_approve` | Approve | posting | Approves a spender for ONE specific NFT |
| 16 | `nft_approve_all` | Approve | posting | Approves a spender for ALL NFTs in a collection |
| 17 | `nft_transfer_from` | Approve | posting | Approved spender transfers an NFT from the owner |
| 18 | `nft_lend` | Lending | posting | Lends an NFT to a borrower |
| 19 | `nft_return` | Lending | posting | Returns a lent NFT |
| 20 | `data_operator_approve` | DataOperator | posting | Authorizes an external operator for a collection |
| 21 | `set_data_from` | DataOperator | posting | Approved operator modifies mutable data of NFTs (requires schema) |

---

## Seed provenance (optional attestation)

Eight operations accept optional `seedId` and `seedTxId` fields in their
payload — `transfer`, `list`, `unlist`, `set_data`, `set_data_from`,
`nft_transfer_from`, `nft_lend`, `nft_return`.

- **Both absent** → the op processes normally (backwards-compatible).
- **Either declared** → the indexer validates the declared field against
  the NFT's canonical `seed_id` and the seed's `created_tx_id`. A mismatch
  or a wrong-type value rejects the whole op.
- **Declared on a seed NFT** → rejected (seeds have no parent seed).

Apps that verify operations directly against Hive L1 can trust these fields
on accepted ops without re-consulting the indexer. See the full semantics
in `packages/protocol/README.md` under "SeedProvenance Attestation".

## Core (9 operations)

### 1. `create_collection`

**SDK constant**: `ACTION_CREATE_COLLECTION`
**Description**: Creates a collection that groups NFTs under shared rules (transfer, burn, royalties).
**Key authority**: active -- node-cosigned collection creation.
**Signer role**: The co-signing node signs the `custom_json`; the collection creator is identified from the paired fee transfer.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Canonical collection ID (must equal `generateDeterministicCollectionId(signer, name, symbol)`) |
| `name` | string | yes | Name (max 100 chars) |
| `symbol` | string | yes | Symbol 3-8 chars, A-Z0-9 |
| `totalPotential` | number | yes | Seed cap (non-negative integer). 0 = unlimited |
| `metadata` | object | yes | Collection metadata (required) |
| `metadata.description` | string | yes | Description |
| `metadata.image` | string | yes | Image URL (HTTPS) |
| `metadata.externalUrl` | string | no | External URL |
| `rules` | object | yes | Collection rules (required, all fields explicit) |
| `rules.transferable` | boolean | yes | Whether NFTs are transferable |
| `rules.burnable` | boolean | yes | Whether NFTs can be burned |
| `rules.royaltyPct` | number | yes | Royalty percentage 0-50 |
| `rules.royaltyRecipient` | string | no | Account that receives royalties |
| `schema` | object | no | Typed schema with `immutable` and `mutable` fields |

**Indexer validations**:
- `id` must be canonical: recalculated from `creator + name + symbol` and rejected if mismatch
- Transaction must include a valid collection fee transfer from creator to node account.
- `id` must not already exist (duplicate is idempotent no-op)
- `creator` is forced to `op.signer`
- `originDna` is always recalculated by the indexer (payload value ignored)
- `metadata`, `rules`, and `totalPotential` are required — missing fields are rejected (no defaults)
- `royaltyPct` must be between 0 and 50
- `totalPotential` must be a non-negative integer

**State changes**: Inserts row in `collections`. If a `schema` is provided, inserts initial `schema_version=1` in `schema_versions`.
**Restrictions**: Non-canonical ID, missing required fields, or invalid values -> rejected.

---

### 2. `mint`

**SDK constant**: `ACTION_MINT`
**Description**: Creates a seed NFT (template) within a collection. Only seeds can be minted directly; instances are created via `bulk_distribute`.
**Key authority**: posting -- only the creator needs to sign.
**Signer role**: Must be the collection creator. Can mint seeds for other owners.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Seed ID (must have `seed_` prefix) |
| `collectionId` | string | yes | Target collection |
| `edition` | number | no | Edition (default 1) |
| `owner` | string | no | Initial owner (default signer) |
| `maxSupply` | number | no | Maximum instances from this seed (default 1, must be >= 1) |
| `metadata.name` | string | no | NFT name |
| `metadata.description` | string | no | Description |
| `metadata.imageUrl` | string | no | Image URL |
| `metadata.imageHash` | string | no | Image hash |
| `immutableData` | object | no | Immutable data validated against schema |
| `mutableData` | object | no | Mutable data validated against schema |
| `collectionBlock` | number | yes | Block where the collection was created (L1 traceability without indexer) |

**Note**: `originDna`, `nftDna`, and `uniqueAccessKey` are always computed by the indexer — any payload values are ignored. The `uniqueAccessKey` is derived from `(nftDna, owner, txId)` and can be verified client-side post-broadcast via `generateDeterministicAccessKey()`.

**Indexer validations**:
- Only seeds can be minted (non-seed nftType is rejected)
- NFT with that `id` must not exist (duplicate is idempotent no-op)
- Collection must exist and not be archived
- `collection.creator === op.signer` (only creator can mint)
- If the collection has a schema, `immutableData`/`mutableData` are validated against it
- If the collection has `totalPotential > 0`, seed cap is validated

**State changes**: Inserts row in `nfts` with type `seed` and status `active`. The NFT is stamped with the collection's current `schema_version`, `owner_operation_id`, `owner_action = "mint"`, `owner_block_num`, and creation anchors.
**Restrictions**: Instance mint, duplicate ID, nonexistent/archived collection, non-creator signer, seed cap reached, or schema validation failure -> rejected.

---

### 3. `transfer`

**SDK constant**: `ACTION_TRANSFER`
**Description**: Transfers ownership of an NFT to another account. Clears the NFT's instance approval and any expired listing fields.
**Key authority**: posting -- the owner signs the transfer.
**Signer role**: Must be the current NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | ID of the NFT to transfer |
| `to` | string | yes | Recipient username |

**Indexer validations**:
- NFT must exist
- `assertTransferable`: status cannot be `burned` or `lent`; if `listed`, the listing must be expired (auto-cleared) otherwise transfer is blocked
- `nft.owner === op.signer`
- Cannot transfer to yourself (`to !== signer`)
- Collection must be transferable (`transferable=true` in rules)

**State changes**: Updates `owner`, `previous_owner`, `owner_operation_id`, `owner_action = "transfer"`, and `owner_block_num` in `nfts`, clears listing fields, deletes `nft_allowances` for that NFT, and removes the sender's `collection_allowances` for the collection if the transfer or burn leaves the sender with zero NFTs in that collection.
**Restrictions**: NFT burned, lent, actively listed, collection not transferable, or signer is not owner -> rejected.
**Burn note**: SDK burn helpers encode burn as `transfer` with `to: "null"`. There is no separate `burn` protocol action in `ALL_ACTIONS`.

---

### 4. `bulk_distribute`

**SDK constant**: `ACTION_BULK_DISTRIBUTE`
**Description**: Mints multiple instances from one or more seeds in a single operation. Generates deterministic DNA. Instances inherit `immutable_data` from the seed automatically.
**Key authority**: posting -- the seed owner signs.
**Signer role**: Must be the seed owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | no | Owner of the instances (default signer) |
| `items` | array | yes | `[{ seedId, quantity, seedTxId }]` -- max 50 items |
| `items[].seedTxId` | string | yes | Transaction ID where the seed was minted (L1 traceability without indexer) |
| `mutableData` | object | no | Mutable data for the instances (validated against schema) |

**Note**: Instances inherit `immutable_data`, `immutable_data_hash`, `name`, and `image_url` from the seed via the `seed → collection` FK chain — instance rows store only references, never duplicates. If the collection has a schema, `mutableData` is validated against the mutable schema fields.

**Indexer validations**:
- Items not empty, max 50
- No duplicate seedIds in items
- Each `seedTxId` must match the actual seed's `tx_id` (provenance verification)
- Each seed must exist, not be burned, not be lent, and must be of type `"seed"`
- Each seed must have available supply (`distributed + quantity <= maxSupply`)
- Signer must be the owner of the seed
- If the collection has a schema and `mutableData` is provided, it is validated against the schema
- `uniqueAccessKey` is computed by the indexer from `(nftDna, recipient, txId)` — not from signer

**State changes**: Inserts N rows in `nfts` (type `instance`) stamped with the collection's current `schema_version`, increments `distributed` on the seed, and stores each instance's creation/current ownership anchors (`owner_operation_id`, `owner_action = "bulk_distribute"`, `owner_block_num`).
**Operation status**: `bulk_distribute` does not store the full created instance list in `confirmed_operations.nft_ids`; it can return `[]` there to keep the confirmation cache bounded. Per-instance provenance comes from each `nfts` row.
**Idempotency**: Detects re-sends of the same txId and adjusts counters.
**Restrictions**: Invalid seedTxId, supply exceeded, nonexistent seeds, or non-owner signer -> rejected.

---

### 5. `set_data`

**SDK constant**: `ACTION_SET_DATA`
**Description**: The collection creator updates the mutable data of an NFT. Requires the collection to have a defined schema.
**Key authority**: posting -- the creator signs.
**Signer role**: Must be the creator of the collection the NFT belongs to.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |
| `nftDna` | string | yes | Instance DNA (must match) |
| `mutableData` | object | yes | Mutable data to update |

**Note**: The collection MUST have a defined schema. No legacy fallback exists. Data sent is validated against the mutable schema fields and merged with existing mutable data.

**Indexer validations**:
- NFT must exist and not be `burned`
- `collection.creator === op.signer` (only creator can use set_data)
- `nftDna` must match the stored DNA
- Collection must have a schema
- `mutableData` is validated against the schema (fields and types)

**State changes**: Updates `mutable_data`, `mutable_data_hash`, `mutable_data_tx`, `mutable_data_block` in `nfts`.
**Restrictions**: NFT burned, signer is not creator, DNA mismatch, collection without schema, schema validation failure -> rejected.

---

### 6. `extend_schema`

**SDK constant**: `ACTION_EXTEND_SCHEMA`
**Description**: The creator adds new fields to a collection schema. Existing fields cannot be deleted or modified; only new fields can be added. If the collection has no schema, a new one is created.
**Key authority**: posting -- the creator signs.
**Signer role**: Must be the collection creator.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collectionId` | string | yes | Collection ID |
| `newImmutableFields` | array | no | New immutable fields `[{ name, type }]` |
| `newMutableFields` | array | no | New mutable fields `[{ name, type }]` |

**Supported field types**: `string`, `bool`, `uint8`, `uint16`, `uint32`, `uint64`, `int8`, `int16`, `int32`, `int64`, `float`, `double`, and their array variants (`string[]`, `bool[]`, etc.).

**Indexer validations**:
- Collection must exist
- `collection.creator === op.signer`
- If the collection already has a schema, new fields are merged with `mergeSchemas()` -- duplicate fields or modifications to existing fields are not allowed
- If the collection has no schema, a new one is created after validating the definition

**State changes**: Updates `schema` in `collections`. Inserts a new row in `schema_versions` with a hash chain linking to the previous version (each version's hash includes the previous version's hash, forming an immutable chain).
**Restrictions**: Nonexistent collection, signer is not creator, duplicate fields, invalid field names -> rejected.

---

### 7. `archive_collection`

**SDK constant**: `ACTION_ARCHIVE_COLLECTION`
**Description**: Archives an empty collection and prevents future mints under that collection ID.
**Key authority**: posting -- the collection creator signs.
**Signer role**: Must be the collection creator.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collectionId` | string | yes | Collection ID |

**Indexer validations**:
- Collection must exist
- `collection.creator === op.signer`
- Collection must have zero NFTs

**State changes**: Inserts an archive record in `archived_collections`, then deletes the empty collection row. Cascades clear collection stats, schema versions, collection allowances, and data operators.
**Restrictions**: Nonexistent collection, signer is not creator, or collection still has NFTs -> rejected.

---

### 8. `node_register`

**SDK constant**: `ACTION_NODE_REGISTER`
**Description**: Opts the node account into the public `l2_nodes` discovery directory. Running a node is permissionless — only nodes that want to be listed for clients to find must emit this op.
**Key authority**: posting -- the node account signs the `custom_json`.
**Signer role**: Must be the node account being registered.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `endpoint` | string | yes | Public HTTPS endpoint for the node |

**Indexer validations**:
- `endpoint` must be a valid HTTPS URL string
- Signer must have ≥`MIN_NODE_REGISTER_HIVE_POWER` effective Hive Power (self-staked + received delegations − out-delegations). No fee is charged; the HP itself is the skin-in-the-game.

> The node's active public key is not carried in the payload. Consumers that need it look it up from the Hive account (`accounts[].active.key_auths`); carrying it on-chain here would drift if the account ever rotated keys.

**State changes**: Upserts `l2_nodes` for the signer with endpoint, active status, block number, and transaction ID.
**Restrictions**: Insufficient effective HP or unresolvable account -> rejected.

---

### 9. `node_heartbeat`

**SDK constant**: `ACTION_NODE_HEARTBEAT`
**Description**: Periodic proof-of-liveness from a registered node. Carries the current ownership state-root hash so SPV clients can compare roots across nodes.
**Key authority**: posting -- the node account signs the `custom_json`.
**Signer role**: Must match an existing entry in `l2_nodes` (rejected otherwise).

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `blockNum` | number | yes | Head block the indexer had processed at heartbeat time |
| `stateRoot` | string | yes | Ownership state-root hash, formatted `sha256:<64-hex>` |
| `indexerVersion` | string | yes | Semver of the emitting indexer binary |

**Indexer validations**:
- `blockNum` must be a non-negative integer
- `stateRoot` must match `/^sha256:[0-9a-f]{64}$/`
- `indexerVersion` must be 1–32 chars
- Signer must be registered in `l2_nodes`
- Consecutive heartbeats from the same node must be at least `MIN_HEARTBEAT_INTERVAL_BLOCKS` apart (spam guard)

**State changes**: Inserts a row into `l2_node_heartbeats` and updates `l2_nodes.last_heartbeat_block` for the signer.
**Restrictions**: Unregistered signer, malformed state-root, or heartbeat emitted too soon -> rejected.

---

## Marketplace (3 operations)

### 10. `list`

**SDK constant**: `ACTION_LIST`
**Description**: Lists an NFT for sale on the marketplace with price and currency.
**Key authority**: posting -- the owner signs the listing.
**Signer role**: Must be the NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |
| `listingId` | string | yes | Deterministic listing ID (must start with `list_`) |
| `listingNonce` | string | yes | Random nonce (12 chars) used to generate the listingId |
| `price` | HiveAmount | yes | `{ amount: "10.000", currency: "HIVE"\|"HBD" }` |
| `expiresAt` | number | no | Expiration timestamp |
| `marketplace` | string | no | Third-party marketplace ID |

**Indexer validations**:
- NFT must exist
- `assertNotBurned`, `assertNotLent`
- Collection must be transferable (`transferable=true` in rules)
- If currently listed, the existing listing must be expired; otherwise must unlist first
- `nft.owner === op.signer`
- `listingId` must start with `list_` prefix
- `listingId` must match the deterministic hash computed from `{ nftId, owner, marketplace, priceAmount, priceCurrency, expiresAt, nonce: listingNonce }`
- Price must have valid Hive format (3 decimals)
- Currency must be HIVE or HBD

**State changes**: Status -> `listed`, stores `listing_price`, `listing_currency`, `listing_expires_at`, `listing_marketplace`, `listing_id`, `listing_tx_id`.
**Restrictions**: NFT burned, lent, collection not transferable, already actively listed, listingId mismatch, or signer is not owner -> rejected.

---

### 11. `unlist`

**SDK constant**: `ACTION_UNLIST`
**Description**: Removes an NFT from the marketplace.
**Key authority**: posting -- the owner signs.
**Signer role**: Must be the NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |

**Indexer validations**:
- NFT must exist
- Status must be `listed`
- `nft.owner === op.signer`

**State changes**: Status -> `active`, clears all listing fields.
**Restrictions**: NFT not listed or signer is not owner -> rejected.

---

### 13. `buy_commitment`

**SDK constant**: `ACTION_BUY_COMMITMENT`
**Description**: Node-broadcast on-chain reservation emitted BEFORE the node co-signs a `buy` transaction. The ordering of commitments inside a Hive block is the network-wide consensus on which node gets to settle the listing, closing the cross-node race that would otherwise leave a losing buyer with irreversibly executed transfers. Emitted automatically by the settlement node during `POST /api/multisig/buy` — no direct SDK call.
**Key authority**: active -- signed with the node's active key.
**Signer role**: The settlement node (identified by `op.required_auths[0]`). A single node may hold up to `MAX_ACTIVE_COMMITMENTS_PER_NODE` concurrent reservations.

**On-chain payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `txHash` | string (40 hex) | yes | Digest of the unsigned buy transaction the node has pledged to co-sign; `handleBuy` later matches `op.txId` against this value |
| `nftId` | string | yes | ID of the NFT being reserved |
| `listingId` | string | yes | Active listing ID |
| `listTxId` | string | yes | Transaction ID of the list operation |
| `buyer` | string | yes | Hive account that will pay and receive ownership |

**Indexer validations** (`handleBuyCommitment`):
- NFT must exist, not burned, not lent
- `status='listed'` OR (`status='pending_sale'` AND `sale_expires_block < currentBlock`), else reject `already committed`
- `listingId` and `listTxId` match the current listing
- `buyer !== owner`
- Per-node cap: < `MAX_ACTIVE_COMMITMENTS_PER_NODE` active reservations

**State changes**: `status='pending_sale'`, `sale_buyer=buyer`, `sale_settlement_node=op.required_auths[0]`, `sale_commitment_op_tx_id=op.txId`, `sale_commitment_buy_tx_hash=data.txHash`, `sale_expires_block=op.blockNum + BUY_COMMITMENT_TTL_BLOCKS`.
**Restrictions**: another node already holds an active reservation for the NFT; listing mismatch; per-node cap exceeded — rejected as `invalid_operation`.

---

### 14. `buy`

**SDK constant**: `ACTION_BUY`
**Description**: Settles a prior `buy_commitment`. The buyer signs the paired transfers + trailing `buy` custom_json with their active key; the node appends its own active signature only AFTER verifying its `buy_commitment` won the cross-node ordering race.
**Key authority**: active -- co-signed by the node and the buyer.
**Signer role**: The co-signing node is `op.signer`. Buyer is identified from `pairedTransfers[0].from` and must match `nft.sale_buyer`.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | ID of the NFT to buy |
| `listingId` | string | yes | Active listing ID (must match `nft.listing_id`) |
| `listTxId` | string | yes | Transaction ID of the list operation (must match `nft.listing_tx_id`) |

**Paired transfers** (generated by the SDK as HIVE operations):
- Transfer to seller (price - royalty - fee)
- Transfer to royaltyRecipient (if applicable and != seller)
- Transfer to feeAccount (protocol fee 1%, if != seller)

**Indexer validations**:
- `op.signer` must be the configured node account (`config.hiveAccount`)
- NFT must exist; `assertNotBurned`, `assertNotLent`
- Status must be `pending_sale` (a matching `buy_commitment` already projected)
- `nft.sale_commitment_buy_tx_hash === op.txId` — the broadcasted tx must be the exact one the node committed to
- `nft.sale_expires_block >= op.blockNum` — commitment not yet swept
- `nft.sale_buyer === buyerFromTransfer` — buyer matches the committed account
- Collection must be transferable
- `listingId` / `listTxId` match current listing; listing not expired
- `verifyTransfers()` validates exact split amounts

**State changes**: `owner` -> buyer, `previous_owner` -> seller, `owner_operation_id` -> current operation id, `owner_action = "buy"`, `owner_block_num` -> current block, status -> `active`, clears listing_* and sale_* columns atomically, deletes `nft_allowances` for the NFT, removes the seller's `collection_allowances` if the buy empties their holdings in that collection. A sale record is inserted in `sales` with `gross_amount`, `royalty_amount`, `protocol_fee`, `seller_net`.
**Restrictions**: NFT not reserved (no matching commitment); commitment hash mismatch; commitment expired; listingId/listTxId mismatch; collection not transferable; incorrect payments — rejected.

---

## Approve/Delegation (3 operations)

### 13. `nft_approve`

**SDK constant**: `ACTION_NFT_APPROVE`
**Description**: Approves a spender to transfer ONE specific NFT from the owner.
**Key authority**: posting -- the owner signs the approval.
**Signer role**: Must be the NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spender` | string | yes | Approved account |
| `instanceId` | string | yes | NFT ID |
| `approved` | boolean | yes | true = approve, false = revoke |

**Indexer validations**:
- `spender != op.signer`
- NFT must exist
- `nft.owner === op.signer`
- NFT cannot be `burned` or `lent`

**State changes**: Upsert/delete in `nft_allowances`.
**Restrictions**: Self-approval, NFT burned/lent, signer is not owner -> rejected.

---

### 14. `nft_approve_all`

**SDK constant**: `ACTION_NFT_APPROVE_ALL`
**Description**: Approves a spender to transfer all of the signer's NFTs in a collection while the approval remains active. Similar to ERC-721 `setApprovalForAll`, but the indexer automatically removes the approval when the signer no longer owns any NFT in that collection.
**Key authority**: posting -- the owner signs.
**Signer role**: The signer is the owner granting permission (signed the tx).

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spender` | string | yes | Approved account |
| `collectionId` | string | yes | Collection ID |
| `approved` | boolean | yes | true = approve, false = revoke |

**Indexer validations**:
- `spender != op.signer`
- Collection must exist
- `approved: true` requires the signer to own at least one NFT in the collection

**State changes**: Upsert/delete in `collection_allowances` with `owner = op.signer`. Collection approvals are also cleaned up after `transfer`, `buy`, `burn`, or `nft_transfer_from` empties the owner's holdings in that collection.
**Restrictions**: Self-approval, nonexistent collection, approving without owning any NFT in the collection -> rejected.

---

### 15. `nft_transfer_from`

**SDK constant**: `ACTION_NFT_TRANSFER_FROM`
**Description**: An approved spender transfers an NFT from the owner to another recipient.
**Key authority**: posting -- the spender signs.
**Signer role**: Must have specific NFT approval or collection-wide approval.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | yes | Current owner |
| `to` | string | yes | Recipient |
| `instanceId` | string | yes | NFT ID |

**Indexer validations**:
- `from != to`
- NFT must exist, `nft.owner === from`
- Status: not `burned` or `lent`; if `listed`, the listing must be expired (auto-cleared) otherwise transfer is blocked
- Collection must be `transferable`
- Authorization: `getNftAllowance(nftId)` or `hasCollectionAllowance(from, signer, collectionId)`

**State changes**: `owner` -> `to`, `previous_owner` -> `from`, `owner_operation_id` -> current operation id, `owner_action = "nft_transfer_from"`, `owner_block_num` -> current block, deletes `nft_allowances` for that NFT, and removes `from`'s `collection_allowances` for the collection if the transfer leaves `from` with zero NFTs in that collection.
**Restrictions**: No authorization, NFT not transferable, burned, lent, or actively listed -> rejected.

---

## Lending (2 operations)

### 16. `nft_lend`

**SDK constant**: `ACTION_NFT_LEND`
**Description**: Lends an NFT to a borrower. The NFT is locked (cannot be transferred, listed, burned, or approved).
**Key authority**: posting -- the owner/lender signs.
**Signer role**: Must be the NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instanceId` | string | yes | NFT ID |
| `borrower` | string | yes | Borrower account |

**Indexer validations**:
- `borrower != op.signer`
- NFT must exist, `nft.owner === op.signer`
- Status must be `active` (not listed, burned, or already lent)
- Collection must be `transferable` (non-transferable NFTs cannot be lent)
- No active loan must exist for this NFT

**State changes**: Status -> `lent`, inserts row in `nft_loans`, deletes `nft_allowances`.
**Restrictions**: Self-lend, NFT not transferable/burned/listed/already lent -> rejected.

---

### 17. `nft_return`

**SDK constant**: `ACTION_NFT_RETURN`
**Description**: Returns a lent NFT. Both the lender and the borrower can execute this action.
**Key authority**: posting -- lender or borrower signs.
**Signer role**: Must be the lender or borrower of the active loan.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instanceId` | string | yes | NFT ID |

**Indexer validations**:
- NFT must exist, status must be `lent`
- Loan must exist in `nft_loans`
- `op.signer === loan.lender || op.signer === loan.borrower`

**State changes**: Status -> `active`, deletes row from `nft_loans`.
**Restrictions**: NFT not lent, signer is neither lender nor borrower -> rejected.

---

## Data Operators (2 operations)

### 18. `data_operator_approve`

**SDK constant**: `ACTION_DATA_OPERATOR_APPROVE`
**Description**: The collection creator authorizes an external operator to modify mutable data of NFTs in that collection.
**Key authority**: posting -- the creator signs.
**Signer role**: Must be the collection creator.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collectionId` | string | yes | Collection ID |
| `operator` | string | yes | Operator account |
| `approved` | boolean | yes | true = approve, false = revoke |

**Indexer validations**:
- `operator != op.signer`
- Collection must exist
- `collection.creator === op.signer`

**State changes**: Upsert/delete in `data_operators`.
**Restrictions**: Self-approval, nonexistent collection, signer is not creator -> rejected.

---

### 19. `set_data_from`

**SDK constant**: `ACTION_SET_DATA_FROM`
**Description**: An approved operator modifies the mutable data (`mutable_data`) of an NFT. Works identically to `set_data` but signed by an authorized operator instead of the creator. Requires the collection to have a defined schema.
**Key authority**: posting -- the operator signs.
**Signer role**: Must be approved as a data operator for the NFT's collection.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |
| `nftDna` | string | yes | Instance DNA (must match) |
| `mutableData` | object | yes | Mutable data to update |

**Note**: The collection MUST have a defined schema. No legacy fallback exists. Data sent is validated against the mutable schema fields and merged with existing mutable data.

**Indexer validations**:
- NFT must exist and not be `burned`
- `nftDna` must match
- `hasDataOperatorApproval(signer, collectionId)` must be true
- Collection must have a schema
- `mutableData` is validated against the schema (fields and types)

**State changes**: Updates `mutable_data`, `mutable_data_hash`, `mutable_data_tx`, `mutable_data_block` in `nfts`.
**Restrictions**: NFT burned, DNA mismatch, no operator approval, collection without schema, schema validation failure -> rejected.

---

## Architecture Notes

### Key Authority
The SDK derives `custom_json` authority from `ACTION_AUTH_LEVEL`: `buy` uses `required_auths`, and every other protocol action uses `required_posting_auths`. The indexer accepts exactly one signer in exactly one authority array, then rejects any action whose submitted authority does not match the canonical map.

### Idempotency
The `bulk_distribute` operation is idempotent: if the same transaction is re-sent (same `txId`), it detects already-created instances and adjusts counters to avoid duplicating NFTs. The baseline is computed by subtracting instances born from the same `txId` from the current `distributed` count.

### Deterministic IDs
Collections and seeds use deterministic IDs generated by the SDK (hash of unique fields). This prevents duplicate creation even if the same transaction is processed multiple times.

### Payment Splits (Marketplace)
The SDK's `calculatePaymentSplit()` function is reused in the indexer to verify payments. The split is:
- **Seller**: price - royalty - fee
- **Royalty**: `totalPrice x royaltyPct / 100` (if royaltyRecipient != seller)
- **Fee**: `totalPrice x 1%` (protocol fee, always goes to the co-signing node)

If royaltyRecipient or feeAccount equals the seller, those amounts merge into the seller payment. Marketplace fees are handled off-chain by the marketplace frontend.

### Multisig
The `create_collection` and `buy` operations are node-cosigned. For collections the client submits the fee transfer + custom_json unsigned; the node validates, signs the custom_json with its active key, and returns the signature so the client can broadcast. For buys the flow is node-last: the buyer pre-signs the full transfer + `buy` custom_json bundle with their active key, the node broadcasts an on-chain `buy_commitment` reserving the NFT, waits for its commitment to win the cross-node ordering race, then appends its own active signature and broadcasts the completed transaction itself. If any step rejects, the buyer's signature is never used and no funds move.

### Data System
The current SDK-owned operation set manages two data layers per NFT:

- **`immutable_data`**: Immutable data defined at mint. Cannot be modified after creation. Only the creator sets them. Validated against the `immutable` fields of the schema.
- **`mutable_data`**: Mutable data controlled by the collection creator (via `set_data`) or by authorized operators (via `set_data_from`). Requires a defined schema on the collection. Validated against the `mutable` fields of the schema. Includes on-chain traceability (`mutable_data_hash`, `mutable_data_tx`, `mutable_data_block`).

### Schema and Validation
Collections can define a typed schema with immutable and mutable fields. The `set_data` and `set_data_from` operations mandatorily require the collection to have a schema. The schema can be extended with `extend_schema` (add new fields) but existing fields cannot be deleted or modified.

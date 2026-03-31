# NFTLox Protocol Operations Catalog v0.4.1

Complete reference for all 25 protocol operations. Each operation is broadcast as a `custom_json` on the Hive blockchain with `id = "nftlox_testnet"`.

---

## Summary

| # | Action | Category | Key | Description |
|---|--------|----------|-----|-------------|
| 1 | `create_collection` | Core | posting | Creates a collection (archetype) |
| 2 | `mint` | Core | posting | Creates a seed NFT within a collection |
| 3 | `transfer` | Core | active | Transfers ownership of an NFT |
| 4 | `burn` | Core | active | Permanently destroys an NFT |
| 5 | `replicate` | Core | posting | Creates a derived replica from an original NFT |
| 6 | `bulk_distribute` | Core | posting | Mints multiple instances from seeds |
| 7 | `set_data` | Core | posting | Creator updates mutable data of an NFT (requires schema) |
| 8 | `set_owner_data` | Core | posting | Owner writes own data to an NFT |
| 9 | `extend_schema` | Core | posting | Creator adds fields to a collection schema |
| 10 | `list` | Marketplace | active | Lists an NFT for sale |
| 11 | `unlist` | Marketplace | posting | Removes an NFT from the marketplace |
| 12 | `buy` | Marketplace | active | Buys a listed NFT (multisig with node) |
| 13 | `pack_create` | Pack | posting | Creates a pack with a probabilistic drop table |
| 14 | `pack_buy` | Pack | active | Buys packs (free or paid) |
| 15 | `pack_transfer` | Pack | active | Transfers packs between users |
| 16 | `pack_open` | Pack | posting | Opens packs and generates NFT instances |
| 17 | `nft_approve` | Approve | active | Approves a spender for ONE specific NFT |
| 18 | `nft_approve_all` | Approve | active | Approves a spender for ALL NFTs in a collection |
| 19 | `nft_transfer_from` | Approve | posting | Approved spender transfers an NFT from the owner |
| 20 | `pack_approve` | Approve | active | Approves a spender to spend N packs |
| 21 | `pack_transfer_from` | Approve | posting | Approved spender transfers packs from the owner |
| 22 | `nft_lend` | Lending | posting | Lends an NFT to a borrower |
| 23 | `nft_return` | Lending | posting | Returns a lent NFT |
| 24 | `data_operator_approve` | DataOperator | active | Authorizes an external operator for a collection |
| 25 | `set_data_from` | DataOperator | posting | Approved operator modifies mutable data of NFTs (requires schema) |

---

## Core (9 operations)

### 1. `create_collection`

**SDK constant**: `ACTION_CREATE_COLLECTION`
**Description**: Creates a collection that groups NFTs under shared rules (transfer, burn, royalties).
**Key authority**: posting -- creator configuration action.
**Signer role**: The signer becomes the collection creator (`creator` field in the payload is ignored).

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
| `rules.replicable` | boolean | yes | Whether NFTs can be replicated |
| `rules.royaltyPct` | number | yes | Royalty percentage 0-50 |
| `rules.royaltyRecipient` | string | no | Account that receives royalties |
| `schema` | object | no | Typed schema with `immutable` and `mutable` fields |

**Indexer validations**:
- `id` must be canonical: recalculated from `signer + name + symbol` and rejected if mismatch
- `id` must not already exist (duplicate is idempotent no-op)
- `creator` is forced to `op.signer`
- `originDna` is always recalculated by the indexer (payload value ignored)
- `metadata`, `rules`, and `totalPotential` are required — missing fields are rejected (no defaults)
- `royaltyPct` must be between 0 and 50
- `totalPotential` must be a non-negative integer

**State changes**: Inserts row in `collections`.
**Restrictions**: Non-canonical ID, missing required fields, or invalid values -> rejected.

---

### 2. `mint`

**SDK constant**: `ACTION_MINT`
**Description**: Creates a seed NFT (template) within a collection. Only seeds can be minted directly; instances are created via `bulk_distribute` or `pack_open`.
**Key authority**: posting -- only the creator needs to sign.
**Signer role**: Must be the collection creator. Can mint seeds for other owners.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Seed ID (must have `seed_` prefix) |
| `collectionId` | string | yes | Target collection |
| `edition` | number | no | Edition (default 1) |
| `owner` | string | no | Initial owner (default signer) |
| `maxReplicas` | number | no | Maximum instances from this seed (default 1, must be >= 1) |
| `metadata.name` | string | no | NFT name |
| `metadata.description` | string | no | Description |
| `metadata.imageUrl` | string | no | Image URL |
| `metadata.imageHash` | string | no | Image hash |
| `immutableData` | object | no | Immutable data validated against schema |
| `mutableData` | object | no | Mutable data validated against schema |
| `collectionBlock` | number | yes | Block where the collection was created (L1 traceability without indexer) |

**Note**: `originDna`, `instanceDna`, and `uniqueAccessKey` are always computed by the indexer — any payload values are ignored. The `uniqueAccessKey` is derived from `(instanceDna, owner, txId)` and can be verified client-side post-broadcast via `generateDeterministicAccessKey()`.

**Indexer validations**:
- Only seeds can be minted (non-seed nftType is rejected)
- NFT with that `id` must not exist (duplicate is idempotent no-op)
- Collection must exist and not be archived
- `collection.creator === op.signer` (only creator can mint)
- If the collection has a schema, `immutableData`/`mutableData` are validated against it
- If the collection has `totalPotential > 0`, seed cap is validated

**State changes**: Inserts row in `nfts` with type `seed` and status `active`.
**Restrictions**: Instance mint, duplicate ID, nonexistent/archived collection, non-creator signer, seed cap reached, or schema validation failure -> rejected.

---

### 3. `transfer`

**SDK constant**: `ACTION_TRANSFER`
**Description**: Transfers ownership of an NFT to another account. Clears approvals and listings.
**Key authority**: active -- the owner signs the transfer.
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

**State changes**: Updates `owner` in `nfts`, clears listing fields, deletes `nft_allowances` for that NFT.
**Restrictions**: NFT burned, lent, actively listed, collection not transferable, or signer is not owner -> rejected.

---

### 4. `burn`

**SDK constant**: `ACTION_BURN`
**Description**: Permanently destroys an NFT. Terminal irreversible state.
**Key authority**: active -- the owner signs the destruction.
**Signer role**: Must be the current NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | ID of the NFT to burn |

**Indexer validations**:
- NFT must exist
- `assertNotBurned`: status cannot be `burned` (prevents double-burn)
- `assertNotLent`: status cannot be `lent`
- `assertNotListed`: status cannot be `listed`
- `nft.owner === op.signer`
- Collection must allow burning (`burnable=true` in rules)

**State changes**: Status -> `burned`, records `burned_by` (signer) and `burned_at_block` (current block), clears listing, deletes `nft_allowances`.
**Restrictions**: Already burned, lent, listed, collection not burnable, or signer is not owner -> rejected.

---

### 5. `replicate`

**SDK constant**: `ACTION_REPLICATE`
**Description**: Creates a derived replica from an original NFT. The replica is a new NFT referencing the original.
**Key authority**: posting -- the owner of the original signs.
**Signer role**: Must be the owner of the original NFT.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | ID of the new replica |
| `originalId` | string | yes | ID of the original NFT |
| `newOwner` | string | yes | Owner of the replica |
| `originDna` | string | no | Origin DNA |
| `instanceDna` | string | no | Instance DNA |
| `uniqueAccessKey` | string | no | Access key (ignored by indexer, generates its own) |
| `name` | string | no | Name (default: "Original Name (Replica)") |

**Indexer validations**:
- Replica with that `id` must not exist
- Original must exist
- `original.owner === op.signer`
- Original cannot be `burned` or `lent`

**State changes**: Inserts row in `nfts` with `nft_type = "replica"`, `originalId` referencing the original.
**Restrictions**: Duplicate ID, original nonexistent/burned/lent, or signer is not owner -> rejected.

---

### 6. `bulk_distribute`

**SDK constant**: `ACTION_BULK_DISTRIBUTE`
**Description**: Mints multiple instances from one or more seeds in a single operation. Generates deterministic DNA. Instances inherit `immutable_data` from the seed automatically.
**Key authority**: posting -- the seed owner or collection creator signs.
**Signer role**: Must be the seed owner OR the collection creator.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | no | Owner of the instances (default signer) |
| `items` | array | yes | `[{ seedId, quantity, seedTxId }]` -- max 50 items |
| `items[].seedTxId` | string | yes | Transaction ID where the seed was minted (L1 traceability without indexer) |
| `imageOverrides` | object | no | `{ seedId: { imageUrl, imageHash } }` -- override per seed |
| `mutableData` | object | no | Mutable data for the instances (validated against schema) |

**Note**: Instances inherit `immutable_data` and `immutable_data_hash` from the seed automatically. If the collection has a schema, `mutableData` is validated against the mutable schema fields.

**Indexer validations**:
- Items not empty, max 50
- No duplicate seedIds in items
- Each `seedTxId` must match the actual seed's `tx_id` (provenance verification)
- Each seed must exist, not be burned, not be lent, and must be of type `"seed"`
- Each seed must have available supply (`distributed + quantity <= maxReplicas`)
- Signer must be the owner of the seed
- If the collection has a schema and `mutableData` is provided, it is validated against the schema
- `uniqueAccessKey` is computed by the indexer from `(instanceDna, recipient, txId)` — not from signer

**State changes**: Inserts N rows in `nfts` (type `instance`), increments `distributed` on the seed.
**Idempotency**: Detects re-sends of the same txId and adjusts counters.
**Restrictions**: Invalid seedTxId, supply exceeded, nonexistent seeds, or non-owner signer -> rejected.

---

### 7. `set_data`

**SDK constant**: `ACTION_SET_DATA`
**Description**: The collection creator updates the mutable data of an NFT. Requires the collection to have a defined schema.
**Key authority**: posting -- the creator signs.
**Signer role**: Must be the creator of the collection the NFT belongs to.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |
| `instanceDna` | string | yes | Instance DNA (must match) |
| `mutableData` | object | yes | Mutable data to update |

**Note**: The collection MUST have a defined schema. No legacy fallback exists. Data sent is validated against the mutable schema fields and merged with existing mutable data.

**Indexer validations**:
- NFT must exist and not be `burned`
- `collection.creator === op.signer` (only creator can use set_data)
- `instanceDna` must match the stored DNA
- Collection must have a schema
- `mutableData` is validated against the schema (fields and types)

**State changes**: Updates `mutable_data`, `mutable_data_hash`, `mutable_data_tx`, `mutable_data_block` in `nfts`.
**Restrictions**: NFT burned, signer is not creator, DNA mismatch, collection without schema, schema validation failure -> rejected.

---

### 8. `set_owner_data`

**SDK constant**: `ACTION_SET_OWNER_DATA`
**Description**: The NFT owner writes data to the `owner_data` field, separate from the creator's `mutable_data`. Does not require schema validation.
**Key authority**: posting -- the owner signs.
**Signer role**: Must be the NFT owner.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |
| `instanceDna` | string | yes | Instance DNA (must match) |
| `data` | object | yes | Data to write to `owner_data` |

**Indexer validations**:
- NFT must exist and not be `burned`
- `nft.owner === op.signer`
- `instanceDna` must match the stored DNA

**State changes**: Updates `owner_data`, `owner_data_hash`, `owner_data_tx`, `owner_data_block` in `nfts`.
**Restrictions**: NFT burned, signer is not owner, DNA mismatch -> rejected.

---

### 9. `extend_schema`

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

**State changes**: Updates `schema` in `collections`.
**Restrictions**: Nonexistent collection, signer is not creator, duplicate fields, invalid field names -> rejected.

---

## Marketplace (3 operations)

### 10. `list`

**SDK constant**: `ACTION_LIST`
**Description**: Lists an NFT for sale on the marketplace with price and currency.
**Key authority**: active -- the owner signs the listing.
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

### 12. `buy`

**SDK constant**: `ACTION_BUY`
**Description**: Buys a listed NFT. Special operation: the node co-signs with active key (multisig). The buyer is extracted from paired transfers, not from the signer.
**Key authority**: active -- signed by the indexer node (multisig).
**Signer role**: The co-signing node. Buyer is identified from `pairedTransfers[0].from`.

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
- NFT must exist
- `assertNotBurned`, `assertNotLent`
- Status must be `listed` and listing must not be expired
- Collection must be transferable (`transferable=true` in rules)
- `listingId` must match `nft.listing_id` (prevents stale listing replays)
- `listTxId` must match `nft.listing_tx_id` (prevents stale listing replays)
- Buyer != seller
- `verifyTransfers()` validates exact amounts of each transfer
- If `royaltyRecipient === seller`, royalty merges into seller payment
- If `feeAccount === seller`, fee merges into seller payment

**State changes**: `owner` -> buyer, status -> `active`, clears listing and allowances.
**Restrictions**: NFT not listed, listing expired, collection not transferable, listingId mismatch, listTxId mismatch, incorrect payments, buyer = seller -> rejected.

---

## Packs (4 operations)

### 13. `pack_create`

**SDK constant**: `ACTION_PACK_CREATE`
**Description**: Creates a pack with a probabilistic drop table. When a pack is opened, instances are generated according to the table weights.
**Key authority**: posting -- the collection creator signs.
**Signer role**: Must be the creator of the associated collection.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Deterministic pack ID |
| `collectionId` | string | yes | Associated collection |
| `name` | string | yes | Pack name |
| `description` | string | no | Description |
| `imageUrl` | string | no | Image URL |
| `dropTable` | array | yes | `[{ seedId, weight }]` -- max 50 entries, weight 1-10000 |
| `itemsPerPack` | number | yes | Items per opening (max 20) |
| `price` | HiveAmount | no | Price per pack (null = free) |
| `maxSupply` | number | yes | Maximum supply |

**Indexer validations**:
- Pack with that `id` must not exist
- `pack.creator === collection.creator === op.signer`
- Each seed in the dropTable must exist, be of type "seed", and belong to the collection
- Seed supply must support the demand (maxSupply x itemsPerPack)
- Price, if present, must be > 0

**State changes**: Inserts row in `packs`.
**Restrictions**: Duplicate ID, invalid seeds, creator mismatch -> rejected.

---

### 14. `pack_buy`

**SDK constant**: `ACTION_PACK_BUY`
**Description**: Buys packs. If the pack has a price, requires a paired HIVE/HBD transfer from buyer to creator.
**Key authority**: active -- the buyer signs.
**Signer role**: Buyer.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `packId` | string | yes | Pack ID |
| `quantity` | number | yes | Quantity to buy |

**Indexer validations**:
- Pack must exist and be active
- Quantity > 0
- Available supply (`current_supply + quantity <= max_supply`)
- For paid packs: paired transfer with exact amount (price x quantity)

**State changes**: Increments `current_supply` in `packs`, upserts in `user_pack_balances`.
**Restrictions**: Supply exhausted, insufficient payment -> rejected.

---

### 15. `pack_transfer`

**SDK constant**: `ACTION_PACK_TRANSFER`
**Description**: Transfers packs between users.
**Key authority**: active -- the sender signs.
**Signer role**: Must be the pack holder.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | yes | Sender (must be signer) |
| `to` | string | yes | Recipient |
| `packId` | string | yes | Pack ID |
| `quantity` | number | yes | Quantity to transfer |

**Indexer validations**:
- Pack must exist
- `from != to`
- Quantity > 0
- `getPackBalance(from, packId) >= quantity`

**State changes**: Debits sender balance, credits recipient in `user_pack_balances`.
**Restrictions**: Insufficient balance, self-transfer -> rejected.

---

### 16. `pack_open`

**SDK constant**: `ACTION_PACK_OPEN`
**Description**: Opens packs and generates deterministic NFT instances based on the drop table. RNG is deterministic (txId, blockNum, signer, packId, index).
**Key authority**: posting -- the pack holder signs.
**Signer role**: Must own the packs.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `packId` | string | yes | Pack ID |
| `quantity` | number | yes | Number of packs to open (max 50) |

**Indexer validations**:
- Pack must exist
- Quantity > 0, max 50
- `getPackBalance(signer, packId) >= quantity`

**Delivery behavior**:
- For each pack, seeds are selected from the drop table using deterministic RNG
- If a selected seed has exhausted its supply (`instanceNumber > maxReplicas`), that individual pack is skipped
- Balance is deducted ONLY for successfully delivered packs (not skipped ones)
- If ALL packs fail delivery (all seeds exhausted), the operation throws an error: `"No packs could be delivered for {packId}: all seeds exhausted"`

**State changes**: Debits balance (only for delivered count), increments `total_opened`, inserts N instances in `nfts`, increments `distributed` per seed.
**Idempotency**: Detects re-sends of the same txId.
**Restrictions**: Insufficient balance -> rejected. All seeds exhausted -> error (no silent skip).

---

## Approve/Delegation (5 operations)

### 17. `nft_approve`

**SDK constant**: `ACTION_NFT_APPROVE`
**Description**: Approves a spender to transfer ONE specific NFT from the owner.
**Key authority**: active -- the owner signs the approval.
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

### 18. `nft_approve_all`

**SDK constant**: `ACTION_NFT_APPROVE_ALL`
**Description**: Approves a spender to transfer ALL of the signer's NFTs in a collection. Analogous to ERC-721 `setApprovalForAll`.
**Key authority**: active -- the owner signs.
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

**State changes**: Upsert in `collection_allowances` with `owner = op.signer`.
**Restrictions**: Self-approval, nonexistent collection -> rejected.

---

### 19. `nft_transfer_from`

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
- Status: not `burned`, not `lent`, not `listed`
- Collection must be `transferable`
- Authorization: `getNftAllowance(nftId)` or `hasCollectionAllowance(from, signer, collectionId)`

**State changes**: `owner` -> `to`, clears allowances.
**Restrictions**: No authorization, NFT not transferable/burned/lent/listed -> rejected.

---

### 20. `pack_approve`

**SDK constant**: `ACTION_PACK_APPROVE`
**Description**: Approves a spender to spend N packs from the owner. Analogous to ERC-20 `approve`.
**Key authority**: active -- the owner signs.
**Signer role**: Must hold a balance of the pack.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spender` | string | yes | Approved account |
| `packId` | string | yes | Pack ID |
| `quantity` | number | yes (if approved) | Approved quantity |
| `approved` | boolean | yes | true = approve, false = revoke |

**Indexer validations**:
- `spender != op.signer`
- Pack must exist
- If `approved`: quantity > 0 and `getPackBalance(signer, packId) >= 1`

**State changes**: Upsert in `pack_allowances`.
**Restrictions**: Self-approval, nonexistent pack, no balance -> rejected.

---

### 21. `pack_transfer_from`

**SDK constant**: `ACTION_PACK_TRANSFER_FROM`
**Description**: An approved spender transfers packs from the owner to another recipient.
**Key authority**: posting -- the spender signs.
**Signer role**: Must have an allowance from the owner for that pack.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | yes | Pack owner |
| `to` | string | yes | Recipient |
| `packId` | string | yes | Pack ID |
| `quantity` | number | yes | Quantity to transfer |

**Indexer validations**:
- `from != to`, quantity > 0
- Pack must exist
- `getPackAllowance(signer, from, packId) >= quantity`
- `getPackBalance(from, packId) >= quantity`

**State changes**: Deducts allowance FIRST (prevents double-spend), then transfers balance.
**Restrictions**: No allowance, insufficient balance -> rejected.

---

## Lending (2 operations)

### 22. `nft_lend`

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

### 23. `nft_return`

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

### 24. `data_operator_approve`

**SDK constant**: `ACTION_DATA_OPERATOR_APPROVE`
**Description**: The collection creator authorizes an external operator to modify mutable data of NFTs in that collection.
**Key authority**: active -- the creator signs.
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

### 25. `set_data_from`

**SDK constant**: `ACTION_SET_DATA_FROM`
**Description**: An approved operator modifies the mutable data (`mutable_data`) of an NFT. Works identically to `set_data` but signed by an authorized operator instead of the creator. Requires the collection to have a defined schema.
**Key authority**: posting -- the operator signs.
**Signer role**: Must be approved as a data operator for the NFT's collection.

**SDK payload**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nftId` | string | yes | NFT ID |
| `instanceDna` | string | yes | Instance DNA (must match) |
| `mutableData` | object | yes | Mutable data to update |

**Note**: The collection MUST have a defined schema. No legacy fallback exists. Data sent is validated against the mutable schema fields and merged with existing mutable data.

**Indexer validations**:
- NFT must exist and not be `burned`
- `instanceDna` must match
- `hasDataOperatorApproval(signer, collectionId)` must be true
- Collection must have a schema
- `mutableData` is validated against the schema (fields and types)

**State changes**: Updates `mutable_data`, `mutable_data_hash`, `mutable_data_tx`, `mutable_data_block` in `nfts`.
**Restrictions**: NFT burned, DNA mismatch, no operator approval, collection without schema, schema validation failure -> rejected.

---

## Architecture Notes

### Key Authority
The indexer extracts the signer from `required_auths[0] ?? required_posting_auths[0]`. It does not validate the key type directly -- key validation is performed by the Hive blockchain when accepting the transaction. The SDK sets the correct authority when building the `custom_json`.

### Idempotency
The `bulk_distribute` and `pack_open` operations are idempotent: if the same transaction is re-sent (same `txId`), they detect already-created instances and adjust counters to avoid duplicating NFTs. The baseline is computed by subtracting instances born from the same `txId` from the current `distributed` count.

### Deterministic IDs
Collections, seeds, and packs use deterministic IDs generated by the SDK (hash of unique fields). This prevents duplicate creation even if the same transaction is processed multiple times.

### Payment Splits (Marketplace)
The SDK's `calculatePaymentSplit()` function is reused in the indexer to verify payments. The split is:
- **Seller**: price - royalty - fee
- **Royalty**: `totalPrice x royaltyPct / 100` (if royaltyRecipient != seller)
- **Fee**: `totalPrice x 1%` (protocol fee, always goes to the co-signing node)

If royaltyRecipient or feeAccount equals the seller, those amounts merge into the seller payment. Marketplace fees are handled off-chain by the marketplace frontend.

### Multisig (Buy)
The `buy` operation is the only one where the node co-signs. The buyer submits transfers (HIVE/HBD) and the node validates and co-signs the `custom_json`. If the node rejects, the funds never leave the buyer's account. The multisig lock window is 125 seconds (`MULTISIG_EXPIRATION_MS = 125_000`). The transaction bundle includes up to 4 operations (`MAX_MULTISIG_OPERATIONS`): seller payment + royalty payment + fee payment + custom_json.

### Data System (v0.4.1)
The protocol manages three data layers per NFT:

- **`immutable_data`**: Immutable data defined at mint. Cannot be modified after creation. Only the creator sets them. Validated against the `immutable` fields of the schema.
- **`mutable_data`**: Mutable data controlled by the collection creator (via `set_data`) or by authorized operators (via `set_data_from`). Requires a defined schema on the collection. Validated against the `mutable` fields of the schema. Includes on-chain traceability (`mutable_data_hash`, `mutable_data_tx`, `mutable_data_block`).
- **`owner_data`**: Data written by the NFT owner (via `set_owner_data`). Does not require schema. Includes on-chain traceability (`owner_data_hash`, `owner_data_tx`, `owner_data_block`).

### Schema and Validation
Collections can define a typed schema with immutable and mutable fields. The `set_data` and `set_data_from` operations mandatorily require the collection to have a schema. The schema can be extended with `extend_schema` (add new fields) but existing fields cannot be deleted or modified.

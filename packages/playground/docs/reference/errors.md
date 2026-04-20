# NFTLox Error Codes Reference

Consolidated reference for all error codes and common error messages across the NFTLox protocol.

---

## Handler Errors

When the indexer processes a protocol operation and validation fails, the operation is recorded in the `invalid_operations` table. The sync loop is never interrupted -- handler errors are infallible. These errors indicate that a broadcast transaction was rejected by the indexer's business logic.

The action router (`processor/action-router.ts`) dispatches each operation to its handler. Every handler call is wrapped in try/catch -- errors are logged and the operation is marked invalid, but the sync continues.

**Orphaned buy detection:** If a `buy` operation fails validation but the associated HIVE transfers were already broadcast, the indexer records them in the `orphaned_buys` table (with a UNIQUE constraint on `tx_id` to prevent duplicates) for manual review.

---

## Multisig Errors

The `MultisigErrorCode` type (defined in `packages/sdk/src/types.ts`) represents all error codes returned by the `POST /api/multisig` endpoint. When a multisig request fails, the response has the shape `{ ok: false, code: MultisigErrorCode, message: string }`.

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `MULTISIG_DISABLED` | 503 | The indexer node does not have multisig enabled (no `ACTIVE_KEY` configured). |
| `RATE_LIMITED` | 429 | Too many multisig requests from this buyer within the rate limit window. |
| `NFT_LOCKED` | 409 | The NFT is currently being purchased by another buyer (DB-backed lock via `multisig_locks` table with expiration). |
| `NFT_NOT_FOUND` | 400 | The specified NFT does not exist in the indexer database. |
| `NFT_NOT_LISTED` | 400 | The NFT is not currently listed for sale on the marketplace. |
| `NFT_NOT_TRANSFERABLE` | 400 | The NFT belongs to a collection with `transferable: false`. |
| `NFT_EXPIRED_LISTING` | 400 | The listing has expired (past its `expiresAt` timestamp). |
| `CANNOT_BUY_OWN` | 400 | The buyer is the same account as the seller. |
| `SEED_HAS_INSTANCES` | 400 | The NFT is a seed with distributed instances — sale blocked. Seeds with `distributed > 0` cannot change ownership. |
| `INVALID_PAYMENT_SPLIT` | 400 | The payment amounts or memo format in the transaction do not match the expected split. Memos must follow strict format: `NFTLox BUY:{nftId}`, `NFTLox ROY:{nftId}`, `NFTLox FEE:{nftId}`. |
| `INVALID_PROTOCOL_PAYLOAD` | 400 | The `custom_json` protocol payload embedded in the transaction is malformed or invalid. |
| `NODE_ACCOUNT_MISMATCH` | 400 | The transaction does not reference the correct node account for co-signing. |
| `MISSING_BUYER_AUTH` | 400 | The buyer's authorization (signature placeholder) is missing from the transaction. |
| `INVALID_TX_STRUCTURE` | 400 | The Hive transaction structure is malformed (wrong operation types, missing fields, etc.). |
| `INTERNAL_ERROR` | 500 | Unexpected server-side error during multisig processing. |

Additionally, the `GET /api/payment-info/:nftId` endpoint returns:

| Status | Meaning |
|--------|---------|
| `410` | Listing has expired (the resource is gone). |

---

## Common Errors

Errors encountered during normal protocol operations (handler validation, Build API responses, and SDK-level checks).

### Supply and Distribution Errors

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `Supply limit reached for seed <seedId>: N/N distributed` | All instances of a seed have been distributed; `bulk_distribute` rejects the entire operation (not just the exhausted seed). | Remove exhausted seeds from your distribution set. Monitor supply levels proactively. Optionally mint a new seed with additional supply. |
| `Seed not found` | The `seedId` does not exist or has not been indexed yet. | Verify the `seedId` is correct. If recently minted, wait for the indexer to catch up. |
| `Seed is burned` | The seed NFT was permanently destroyed via `burn`. | Remove the seed from your distribution set entirely. |
| `Signer is not the owner of seed` | The account signing the `bulk_distribute` operation is not the current owner of the seed. Only the owner can distribute — collection creators no longer have implicit distribution rights. | Use the seed owner's posting key. If ownership was transferred, only the new owner can distribute. |
| `Seed has N distributed instance(s) — ownership transfer blocked` | A seed with distributed instances cannot be transferred, listed, sold, or delegated. Following AtomicAssets pattern. | Seeds with `distributed > 0` are permanently locked to their owner. Only seeds with `distributed === 0` can be transferred. |
| `Seeds cannot be delegated` | Seeds cannot be approved (`nft_approve`) or lent (`nft_lend`) regardless of distribution count. | Use instances for delegation, not seeds. |
| `maxSupply must be >= 1 for seeds` | Seeds require at least 1 max supply at mint time. | Set `maxSupply` to a positive integer when minting seeds. |
| `Payload too large` | The `custom_json` payload exceeds `SAFE_PAYLOAD_MAX_BYTES` (7,372 bytes). | Split into multiple operations. For `bulk_distribute`, reduce the number of items per call. |
| `Seed {seedId} insufficient supply: needs {N}, available {M}` | `bulk_distribute` requests more instances than the seed has remaining. | Reduce the requested quantity or mint a new seed with additional supply. |
| `Collection {collectionId} reached its seed cap: {N}/{M}` | Minting a new seed would exceed the collection's `totalPotential`. | Increase `totalPotential` or use an existing seed. |

### Status Guard Errors

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `NFT is burned: {nftId}` | The NFT was permanently destroyed via `burn`. | Remove the NFT from any active workflows. |
| `NFT is lent and cannot be modified: {nftId}` | The NFT is currently lent to another user. | Return the NFT first via `nft_return`, then retry the operation. |
| `NFT is listed and must be unlisted first: {nftId}` | The NFT is on the marketplace. Transfer, burn, lend, and approve operations are blocked while listed. | Call `unlist` first, then retry the operation. |

### Schema and Data Errors

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `Schema validation failed` | The `mutableData` or `immutableData` provided does not match the collection's schema (wrong field names or types). | Check field names and types against the collection schema definition. Use the correct scalar types (e.g., `uint8` range is 0-255). |

### Marketplace Errors

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `NFT not listed` | Attempting to buy or unlist an NFT that is not currently on the marketplace. | Verify the NFT's status is `listed` before attempting the operation. |
| `NFT not found` | The NFT ID does not exist. | Double-check the `nftId`. |
| `NFT not listed or has no valid price` | The NFT exists but either is not listed or its listing price is invalid. | Fetch fresh payment info via `GET /api/payment-info/:nftId` before building a buy transaction. |
| `listingId mismatch` / `listTxId mismatch` | The listing reference in the multisig request does not match the current listing (stale data). | Re-fetch payment info and rebuild the buy transaction with fresh listing data. |
| `Invalid Hive amount format` | The HIVE transfer amount in the multisig request is malformed or does not have exactly 3 decimal places. | Use the exact amount format from `GET /api/payment-info/:nftId` (e.g., `"10.000 HIVE"`). |

### Builder validation errors

Every SDK builder returns a `KeychainResult<T>`. On failure the shape is:

```typescript
{
	success: false,
	errors: [
		{ field: "name", message: "Name is required", code: "invalid_type" },
		// …
	]
}
```

Each entry has:

- `field` — the input field that failed validation (dotted path for nested objects).
- `message` — human-readable description.
- `code` — Zod error code (`invalid_type`, `too_small`, `invalid_string`, `custom`, …) or a protocol-level code such as `CANNOT_BUY_OWN`, `LEND_TO_SELF`, `INTERNAL_ERROR`.

Never broadcast when `success: false` — `operations` is not present on the failure branch, and TypeScript will narrow it away for you if you branch on `result.success`.

### HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `400` | Bad request (validation error, business rule violation) |
| `404` | Resource not found |
| `409` | Conflict (NFT locked by another buyer) |
| `429` | Rate limited |
| `500` | Internal server error |
| `503` | Indexer syncing or multisig disabled |

---

## Retry Safety

`bulk_distribute` is **idempotent** -- deterministic instance IDs mean duplicate broadcasts are silently skipped. It is safe to retry on network errors without risk of creating duplicate NFTs.

For other operations, retry logic should verify the current state before re-broadcasting (e.g., check if the NFT is still listed before retrying a buy).

---

## Indexer memo-binding errors (create_collection)

Since 0.6.0 the indexer pairs the collection-fee transfer to the payload by memo, not by position. If you build the transaction with the SDK (`buildCollection`) the correct memo is emitted automatically; if you roll your own, these errors flag mistakes.

| Error message | When | Fix |
|---|---|---|
| `No fee transfer found matching memo 'NFTLox FEE-COL:...'` | The indexer could not find the expected memo-bound fee transfer. | Ensure the fee transfer uses the canonical memo; do not rely on untagged transfers. |
| `Ambiguous fee transfers — N memo matches for 'NFTLox FEE-COL:...'` | Two or more transfers carry the same fee memo. | Send exactly one fee transfer per create_collection op. |
| `Protocol fees must be paid in HBD, got HIVE. Required: 0.100 HBD` | Since **0.6.2** the fee currency is consensus-enforced to HBD. HIVE transfers (or any other currency) are rejected even if the amount and memo match. | Use `buildCollection` or emit the transfer with `currency: "HBD"`. |
| `Fee amount mismatch — HBD payment must equal 0.100, got X` | The HBD amount deviates from `PROTOCOL_COLLECTION_FEE_HBD`. | Overpaying is no longer tolerated — send exactly the required amount. |

## Listing expiration errors

Since **0.6.2** the indexer enforces a minimum listing TTL (`MIN_LISTING_TTL_MS = 180_000`) so a buy transaction in flight always has a settlement window wider than its own L1 expiration. See [Marketplace — Why listings need a minimum TTL](../guides/marketplace.md#why-listings-need-a-minimum-ttl) for the full rationale.

| Error message | When | Fix |
|---|---|---|
| `Listing expiresAt is too soon for safe settlement: must be more than 180s after the listing block timestamp` | `handleList` rejected a `list` op whose `expiresAt` falls inside the settlement window. | Pick `expiresAt > Date.now() + MIN_LISTING_TTL_MS` before signing. |
| `Listing expires too soon for safe settlement: listing must expire more than 60s after transaction expiration` (`NFT_EXPIRED_LISTING`) | Multisig `buy` refused to co-sign because the listing would expire before the transaction's settlement buffer. | Ask the seller to relist with a longer `expiresAt`, or set transaction `expiration` further in the future (bounded by `MULTISIG_TX_MAX_EXPIRATION_MS`). |

# NFTLox Error Codes Reference

Consolidated reference for all error codes and common error messages across the NFTLox protocol.

---

## Handler Errors

When the indexer processes a protocol operation and validation fails, the operation is recorded in the `invalid_operations` table. The sync loop is never interrupted -- handler errors are infallible. These errors indicate that a broadcast transaction was rejected by the indexer's business logic.

The action router (`processor/action-router.ts`) dispatches each operation to its handler. Every handler call is wrapped in try/catch -- errors are logged and the operation is marked invalid, but the sync continues.

**Orphaned buy detection:** If a `buy` operation fails validation but the associated HIVE transfers were already broadcast, the indexer flags these for manual review.

---

## Multisig Errors

The `MultisigErrorCode` type (defined in `packages/sdk/src/types.ts`) represents all error codes returned by the `POST /api/multisig` endpoint. When a multisig request fails, the response has the shape `{ ok: false, code: MultisigErrorCode, message: string }`.

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `MULTISIG_DISABLED` | 503 | The indexer node does not have multisig enabled (no `ACTIVE_KEY` configured). |
| `RATE_LIMITED` | 429 | Too many multisig requests from this buyer within the rate limit window. |
| `NFT_LOCKED` | 409 | The NFT is currently being purchased by another buyer (concurrent lock). |
| `NFT_NOT_FOUND` | 400 | The specified NFT does not exist in the indexer database. |
| `NFT_NOT_LISTED` | 400 | The NFT is not currently listed for sale on the marketplace. |
| `NFT_NOT_TRANSFERABLE` | 400 | The NFT belongs to a collection with `transferable: false`. |
| `NFT_EXPIRED_LISTING` | 400 | The listing has expired (past its `expiresAt` timestamp). |
| `CANNOT_BUY_OWN` | 400 | The buyer is the same account as the seller. |
| `INVALID_PAYMENT_SPLIT` | 400 | The payment amounts in the transaction do not match the expected seller/royalty/fee split. |
| `INVALID_PROTOCOL_PAYLOAD` | 400 | The `custom_json` protocol payload embedded in the transaction is malformed or invalid. |
| `NODE_ACCOUNT_MISMATCH` | 400 | The transaction does not reference the correct node account for co-signing. |
| `MISSING_BUYER_AUTH` | 400 | The buyer's authorization (signature placeholder) is missing from the transaction. |
| `INVALID_TX_STRUCTURE` | 400 | The Hive transaction structure is malformed (wrong operation types, missing fields, etc.). |
| `INTERNAL_ERROR` | 500 | Unexpected server-side error during multisig processing. |

---

## Common Errors

Errors encountered during normal protocol operations (handler validation, Build API responses, and SDK-level checks).

### Supply and Distribution Errors

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `Supply limit reached for seed <seedId>: N/N distributed` | All instances of a seed have been distributed; `bulk_distribute` rejects the entire operation (not just the exhausted seed). | Remove exhausted seeds from your drop table. Monitor supply levels proactively. Optionally mint a new seed with additional supply. |
| `Seed not found` | The `seedId` does not exist or has not been indexed yet. | Verify the `seedId` is correct. If recently minted, wait for the indexer to catch up. |
| `Seed is burned` | The seed NFT was permanently destroyed via `burn`. | Remove the seed from your drop table entirely. |
| `Signer is not owner of seed` | The account signing the `bulk_distribute` operation is not the current owner of the seed. | Use the seed owner's posting key. If ownership was transferred, only the new owner can distribute. |
| `Payload too large` | The `custom_json` payload exceeds `SAFE_PAYLOAD_MAX_BYTES` (7,372 bytes). | Split into multiple operations. For `bulk_distribute`, reduce the number of items per call. |

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

### Build API Errors

Build API endpoints return errors in a structured format when `success: false`:

```json
{
	"success": false,
	"errors": [
		{ "field": "name", "message": "Name is required", "code": "invalid_type" }
	]
}
```

Each error object contains:
- `field` -- The input field that failed validation.
- `message` -- Human-readable description of the issue.
- `code` -- Zod error code (e.g., `invalid_type`, `too_small`, `invalid_string`).

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

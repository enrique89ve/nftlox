# NFTLox SDK Functions Reference

Quick-lookup reference for all exports from the `nftlox-sdk` package. For installation and usage examples, see the [SDK README](../../packages/sdk/README.md).

---

## Constants

| Export | Description |
|--------|-------------|
| `PROTOCOL_ID` | `"nftlox_testnet"` |
| `PROTOCOL_VERSION` | `"0.5.3"` |
| `ALL_ACTIONS` | All 19 SDK protocol actions |
| `CORE_ACTIONS` | 9 core actions |
| `MARKETPLACE_ACTIONS` | 3 marketplace actions (list, unlist, buy) |
| `APPROVE_ACTIONS` | 3 approve/transferFrom actions |
| `LENDING_ACTIONS` | 2 lending actions (nft_lend, nft_return) |
| `DATA_OPERATOR_ACTIONS` | 2 data operator actions |
| `isProtocolAction(value)` | Runtime guard for SDK-owned protocol actions |
| `SUPPORTED_CURRENCIES` | `["HIVE", "HBD"]` |
| `PROTOCOL_FEE_BPS` | `100` (protocol fee in basis points, 1% on sales) |
| `MEMO_PREFIX_BUY` | `"NFTLox BUY:"` — strict memo prefix for seller transfer |
| `MEMO_PREFIX_ROYALTY` | `"NFTLox ROY:"` — strict memo prefix for royalty transfer |
| `MEMO_PREFIX_FEE` | `"NFTLox FEE:"` — strict memo prefix for fee transfer |
| `calculatePaymentSplit()` | Compute seller/royalty/fee split for a sale |

---

## Protocol State

| Function | Description |
|----------|-------------|
| `initProtocol(baseUrl?)` | Initialize SDK protocol state from the indexer API. Fetches version and ID from `/api/status`. Falls back to constants if not called. |
| `makePayload(action, data)` | Create a protocol payload envelope with protocol ID and version injected automatically from runtime state. |
| `getProtocolVersion()` | Get current protocol version (from API if initialized, from constants otherwise). |
| `getProtocolId()` | Get current protocol ID (from API if initialized, from constants otherwise). |
| `isInitialized()` | Check if `initProtocol()` has been called successfully. |

---

## Payload Creators

| Function | Description |
|----------|-------------|
| `makePayload(action, data)` | Create a protocol payload envelope with protocol ID and version injected automatically from runtime state. |
| `createDeterministicCollectionPayload()` | Create collection (deterministic ID) |
| `createDeterministicMintPayload()` | Mint seed/NFT (deterministic ID) |
| `createBulkDistributePayload()` | Bulk distribute instances from seed |
| `createTransferPayload()` | Transfer NFT |
| `createBurnPayload()` | Burn helper (emits `transfer` to `null`) |
| `createSetDataPayload()` | Update custom data/tags |
| `createArchiveCollectionPayload()` | Archive collection |
| `createNodeRegisterPayload()` | Register an L2 node |
| `createListPayload()` | List on marketplace |
| `createUnlistPayload()` | Remove listing |
| `createBuyPayload()` | Buy listed NFT (multisig) |
| `createNftApprovePayload()` | Approve spender for NFT |
| `createNftApproveAllPayload()` | Approve spender for collection |
| `createNftTransferFromPayload()` | Transfer as approved spender |
| `createNftLendPayload()` | Lend NFT to borrower |
| `createNftReturnPayload()` | Return lent NFT |
| `createExtendSchemaPayload()` | Extend collection schema |
| `createDataOperatorApprovePayload()` | Approve data operator |
| `createSetDataFromPayload()` | Write data as operator |

Each payload creator has a matching `create*Operation()` that wraps it in a `custom_json` Hive operation tuple.

---

## Builders (Zod-validated, standalone pure functions)

Higher-level functions that validate input via Zod schemas, generate deterministic IDs, and return a `BuildResult` with `payload`, `operation`, and optional `generatedId`/`warnings`.

| Function | Description |
|----------|-------------|
| `buildCollection()` | Validate + build collection |
| `buildSeed()` | Validate + build seed NFT |
| `buildSeedBatch()` | Validate + build multiple seeds |
| `buildBulkDistribute()` | Validate + build bulk distribute |
| `buildTransfer()` | Validate + build transfer |
| `buildList()` | Validate + build marketplace listing |
| `buildUnlist()` | Validate + build unlist |
| `buildBuy()` | Validate + build buy (with payment split) |
| `buildBurn()` | Validate + build burn helper (`transfer` to `null`) |
| `buildSetData()` | Validate + build set-data |
| `buildArchiveCollection()` | Validate + build archive collection |
| `buildNodeRegister()` | Validate + build node registration |
| `buildNodeHeartbeat()` | Validate + build node heartbeat (state-root announce) |
| `buildSetDataFrom()` | Validate + build set-data-from |
| `buildNftApprove()` | Validate + build NFT approve |
| `buildNftApproveAll()` | Validate + build collection-wide approve |
| `buildNftTransferFrom()` | Validate + build NFT transfer-from |
| `buildNftLend()` | Validate + build lend |
| `buildNftReturn()` | Validate + build return |
| `buildDataOperatorApprove()` | Validate + build data operator approve |
| `computeSeedAvailability()` | Compute remaining supply from seed fields |

---

## Pre-validation

Pure function to validate an NFT operation against current state before broadcasting. No API calls — the caller passes NFT data fetched from `GET /api/nfts/:id`.

```typescript
import { validateNftOperation, ACTION_TRANSFER } from "nftlox-sdk";

const nft = await indexer.getNft("seed_abc123");
const result = validateNftOperation(ACTION_TRANSFER, nft, "alice", nft.id);
if (!result.valid) {
  console.error(result.errors);
  // → ["Seed seed_abc123 has 50 distributed instance(s) — ownership transfer blocked"]
}
```

| Function | Description |
|----------|-------------|
| `validateNftOperation(action, nft, signer, nftId)` | Pre-validate any NFT operation against current state |

Related types: `NftState`, `PreValidationResult`.

**Checks performed:** burned, lent, listed status, ownership, seed delegation guard, seed distribution guard, supply exhaustion, collection transferable/burnable, buy/unlist state.

**Not checked (indexer-only):** listing expiry, spender authorization, payment splits, schema validation, listing ID determinism.

---

## Multisig Client

Functions for interacting with an indexer node's multisig endpoints (buy flow).

| Function | Description |
|----------|-------------|
| `fetchPaymentInfo(indexerUrl, nftId)` | Fetch payment split for building a buy tx |
| `requestBuyMultisig(indexerUrl, request)` | Send unsigned buy tx for node co-signature |
| `requestCreateCollectionMultisig(indexerUrl, request)` | Send unsigned collection tx for node co-signature |

Related types: `BuyMultisigRequest`, `CreateCollectionMultisigRequest`, `MultisigResponse`, `MultisigErrorCode`, `PaymentInfo`.

---

## Indexer Client

Portable API client using only `fetch()` -- works in browser, Bun, and Node.

```typescript
const indexer = createIndexerClient("http://localhost:3050");
const status = await indexer.getStatus();
const nft = await indexer.getNft("nft_abc123");
```

| Method | Description |
|--------|-------------|
| `getStatus()` | Sync status |
| `getHealth()` | Health check |
| `getStats()` | Protocol statistics |
| `getCollections(params?)` | List collections |
| `getCollection(id)` | Collection by ID |
| `getCollectionNfts(id, params?)` | NFTs in collection |
| `getCollectionStats(id)` | Collection statistics |
| `getNft(id)` | NFT by ID |
| `getNftInstances(id, params?)` | Instances from seed |
| `getUserNfts(username, params?)` | User's NFTs with counts |
| `getUserNftCounts(username)` | NFT counts by type |
| `getUserCollections(username, params?)` | User's collections |
| `getListings(params?)` | Marketplace listings |
| `getPaymentInfo(nftId)` | Payment split for buy |
| `multisig(request)` | Request multisig signing |

---

## Zod Schemas

Exported from `schemas.ts`. Each schema validates input for its corresponding action.

| Schema | Description |
|--------|-------------|
| `createCollectionInputSchema` | Collection creation |
| `mintInputSchema` | Mint input |
| `listInputSchema` | List input |
| `unlistInputSchema` | Unlist input |
| `burnInputSchema` | Burn input |
| `bulkDistributeInputSchema` | Bulk distribute input |
| `setDataInputSchema` | Set data input |
| `dataOperatorApproveInputSchema` | Data operator approve |
| `setDataFromInputSchema` | Set data from input |
| `nftApproveInputSchema` | NFT approve input |
| `nftApproveAllInputSchema` | NFT approve-all input |
| `nftTransferFromInputSchema` | NFT transfer-from input |
| `nftLendInputSchema` | NFT lend input |
| `nftReturnInputSchema` | NFT return input |
| `atomicTransferInputSchema` | Atomic transfer input |
| `usernameSchema` | Hive username validation |
| `priceSchema` | Price object validation |

---

## SPV Verification ("Boleto Suizo")

Trustless verification -- the browser reads Hive L1 directly and replays deterministic logic to verify the indexer.

| Function | Description |
|----------|-------------|
| `verifyNftOwnership(params)` | Verify NFT ownership chain (samples up to 3 events) |
| `verifyOperationOnChain(params)` | Verify any operation exists on L1 |
| `fetchTransaction(config, txId)` | Fetch tx from HAFAH REST API |
| `parseNftloxOperation(tx)` | Parse NFTLox custom_json from tx |
| `verifyDeterministicDerivation(params)` | Verify instanceId/DNA/accessKey derivation |

---

## Transaction Utilities

| Function | Description |
|----------|-------------|
| `estimateOperationSize(operation)` | Estimate byte size of a Hive operation |
| `validateOperationSize(operation)` | Validate operation fits within Hive tx limits |
| `splitIntoBatches(items, maxBatchSize)` | Split items into transaction-safe batches |
| `calculateMaxOperationsPerTx(targetByteSize)` | Calculate max ops for a target byte size |

---

## DNA & ID Generation

| Function | Description |
|----------|-------------|
| `generateOriginDna()` | Collection-level DNA (async) |
| `generateInstanceDna()` | NFT-level DNA |
| `generateDeterministicAccessKey()` | Verify access key post-broadcast (instanceDna, owner, txId) |
| `generateDeterministicCollectionId()` | Deterministic collection ID |
| `generateDeterministicSeedId()` | Deterministic seed ID |
| `generateDeterministicInstanceId()` | Deterministic instance ID |
| `isSeedId()` / `isInstanceId()` | ID type checks |

---

## Types

All TypeScript interfaces are exported: `CollectionData`, `NFTData`, `ProtocolPayload`, `Price`, `HiveOperation`, `NftLendData`, `BuyData`, `PaymentInfo`, `MultisigRequest`, `MultisigResponse`, `BuildResult`, `ValidationError`, and more.

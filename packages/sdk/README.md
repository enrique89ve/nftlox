# NFTLox SDK

Core protocol library for **NFTLox** -- a Polymorphic Ownership infrastructure on Hive blockchain. Enables emitting digital assets with "functional DNA" that separates economic ownership from logical utility, without smart contracts.

## Installation

```bash
bun add nftlox-sdk
```

## Quick Start

```typescript
import {
	createDeterministicCollectionPayload,
	createDeterministicMintPayload,
	createBulkDistributePayload,
	createTransferPayload,
	createNftLendOperation,
	createNftReturnOperation,
	fetchPaymentInfo,
	requestMultisig,
	createIndexerClient,
	createDefaultL1Config,
	verifyNftOwnership,
} from "nftlox-sdk";

// 1. Create a collection
const collection = createDeterministicCollectionPayload({
	name: "My Collection",
	symbol: "MYCOL",
	creator: "username",
	totalPotential: 1000,
	metadata: { description: "...", image: "https://..." },
	rules: { transferable: true, burnable: true, royaltyPct: 5 },
});

// 2. Mint a seed NFT
const seed = createDeterministicMintPayload({
	artId: "unique-art-id",
	collectionId: collection.data.id,
	collectionOriginDna: collection.data.originDna,
	edition: 1,
	owner: "username",
	name: "NFT Name",
	imageUrl: "https://...",
	maxSupply: 100,
});

// 3. Lend an NFT (protocol-level, owner keeps ownership)
const lendOp = createNftLendOperation(
	{ instanceId: "nft_abc123", borrower: "bob" },
	"alice", // owner signs with posting key
);

// 4. Buy an NFT via multisig
const info = await fetchPaymentInfo("https://indexer.nftlox.com", "nft_xyz");
const result = await requestMultisig("https://indexer.nftlox.com", {
	buyer: "alice",
	nftId: "nft_xyz",
	transaction: unsignedTx,
});

// 5. SPV ownership check -- verify indexer claims against Hive L1
const ownership = await verifyNftOwnership({
	nftId: "nft_xyz",
	expectedOwner: "alice",
	indexerBaseUrl: "https://indexer.nftlox.com",
	l1Config: createDefaultL1Config(),
});
console.log(ownership.status);
```

## Protocol Initialization

Before creating payloads, initialize the SDK from the indexer API to ensure the correct protocol version and ID are used:

```typescript
import { initProtocol, createIndexerClient } from "nftlox-sdk";

// Initialize protocol state from the indexer API (call once at startup)
await initProtocol("https://api-nftlox.hivecreators.co");

// Or use default URL:
await initProtocol();
```

- `initProtocol(baseUrl?)` fetches the current protocol version and ID from the indexer's `/api/status` endpoint.
- Must be called **once at startup**, before creating any payloads, to ensure the SDK uses the correct on-chain version.
- If not called, the SDK falls back to the built-in `PROTOCOL_ID` and `PROTOCOL_VERSION` constants (offline mode).
- Default URL: `https://api-nftlox.hivecreators.co/api/status`

After initialization, use `makePayload()` to create protocol payload envelopes -- it injects the correct protocol ID and version automatically:

```typescript
import { makePayload } from "nftlox-sdk";

const payload = makePayload("transfer", {
	instanceId: "nft_abc123",
	to: "bob",
});
// payload.protocol and payload.version are set automatically
```

## API Reference

### Constants

| Export | Description |
|--------|-------------|
| `PROTOCOL_ID` | `"nftlox_testnet"` |
| `PROTOCOL_VERSION` | `"0.5.0"` |
| `ALL_ACTIONS` | All 18 SDK protocol actions |
| `CORE_ACTIONS` | 8 core actions |
| `MARKETPLACE_ACTIONS` | 3 marketplace actions (list, unlist, buy) |
| `APPROVE_ACTIONS` | 3 approve/transferFrom actions |
| `LENDING_ACTIONS` | 2 lending actions (nft_lend, nft_return) |
| `DATA_OPERATOR_ACTIONS` | 2 data operator actions |
| `isProtocolAction(value)` | Runtime guard for SDK-owned protocol actions |
| `SUPPORTED_CURRENCIES` | `["HIVE", "HBD"]` |
| `PROTOCOL_FEE_BPS` | `100` (protocol fee in basis points, 1% on sales) |
| `calculatePaymentSplit()` | Compute seller/royalty/fee split for a sale |

### Protocol State

| Function | Description |
|----------|-------------|
| `initProtocol(baseUrl?)` | Initialize SDK from indexer API (fetches version/ID from `/api/status`) |
| `makePayload(action, data)` | Create a protocol payload envelope with protocol ID and version injected automatically |
| `getProtocolVersion()` | Get current protocol version (from API if initialized, built-in constants otherwise) |
| `getProtocolId()` | Get current protocol ID (from API if initialized, built-in constants otherwise) |
| `isInitialized()` | Check if `initProtocol()` has been called |

`/api/status` unit notes:
- `protocolFeeBps`: basis points, `100 = 1%`
- `maxRoyaltyBps`: basis points, `5000 = 50%`
- block fields are Hive block numbers
- `multisigClockDriftMs` is expressed in milliseconds

### Payload Creators

| Function | Description |
|----------|-------------|
| `createDeterministicCollectionPayload()` | Create collection (deterministic ID) |
| `createDeterministicMintPayload()` | Mint seed/NFT (deterministic ID) |
| `createBulkDistributePayload()` | Bulk distribute instances from seed (`seedTxId` per item) |
| `createTransferPayload()` | Transfer NFT |
| `createBurnPayload()` | Burn helper (emits `transfer` to `null`) |
| `createSetDataPayload()` | Update custom data/tags |
| `createArchiveCollectionPayload()` | Archive an empty collection |
| `createNodeRegisterPayload()` | Register an L2 node |
| `createListPayload()` | List on marketplace |
| `createUnlistPayload()` | Remove listing |
| `createBuyPayload()` | Buy listed NFT (multisig) |
| `createNftApprovePayload()` | Approve spender for NFT |
| `createNftApproveAllPayload()` | Approve spender for collection |
| `createNftTransferFromPayload()` | Transfer as approved spender |
| `createNftLendPayload()` | Lend NFT to borrower |
| `createNftReturnPayload()` | Return lent NFT |
| `createDataOperatorApprovePayload()` | Approve data operator |
| `createSetDataFromPayload()` | Write data as operator |

Each payload creator has a matching `create*Operation()` that wraps it in a `custom_json` Hive operation tuple.

> **Note:** For direct payload construction, prefer `makePayload(action, data)` over manually setting `PROTOCOL_ID` and `PROTOCOL_VERSION`. It automatically uses the correct values from the initialized state (or falls back to built-in constants).

### Builders (Zod-validated, standalone pure functions)

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
| `buildArchiveCollection()` | Validate + build collection archive |
| `buildNodeRegister()` | Validate + build node registration |
| `buildSetDataFrom()` | Validate + build set-data-from |
| `buildNftApprove()` | Validate + build NFT approve |
| `buildNftApproveAll()` | Validate + build collection-wide approve |
| `buildNftTransferFrom()` | Validate + build NFT transfer-from |
| `buildNftLend()` | Validate + build lend |
| `buildNftReturn()` | Validate + build return |
| `buildDataOperatorApprove()` | Validate + build data operator approve |
| `computeSeedAvailability()` | Compute remaining supply from seed fields |

### Multisig Client

Functions for interacting with an indexer node's multisig endpoints (buy flow).

| Function | Description |
|----------|-------------|
| `fetchPaymentInfo(indexerUrl, nftId)` | Fetch payment split for building a buy tx |
| `requestMultisig(indexerUrl, request)` | Send unsigned tx for node co-signature |

Related types: `MultisigRequest`, `MultisigResponse`, `MultisigErrorCode`, `PaymentInfo`.

### Indexer Client

Portable API client using only `fetch()` -- works in browser, Bun, and Node.

```typescript
const indexer = createIndexerClient("http://localhost:3050");
const status = await indexer.getStatus();
console.log(status.protocolFeeBps, status.maxRoyaltyBps);
const health = await indexer.getHealth();
console.log(health.liveness.status, health.readiness.status);
const schemaHistory = await indexer.getCollectionSchemaHistory("col_abc123");
const opStatus = await indexer.getOperationStatus("506be0e61ae4dbb504397d7fb6ba59dbbab7e02e");
const nft = await indexer.getNft("nft_abc123");
const ownerClaim = await indexer.getNftOwner("nft_abc123");
const ownership = await indexer.getNftOwnership("nft_abc123");
const nftProof = await indexer.getNftProof("nft_abc123");
const nftLoan = await indexer.getNftLoan("nft_abc123");
const assets = await indexer.getUserAssets("alice", { previewLimit: 6 });
console.log(ownerClaim.owner, ownerClaim.owner_operation_id, ownership.claim_hash);
console.log(nftLoan.active, assets.counts.borrowed);
```

| Method | Description |
|--------|-------------|
| `getStatus()` | Sync status |
| `getHealth()` | Aggregated health check (`liveness` + `readiness`) |
| `getStats()` | Protocol statistics, including schema count and sales aggregates |
| `getCollections(params?)` | List collections, optionally filtered by `creator` |
| `getCollection(id)` | Active collection by ID (detail view) |
| `getCollectionSchemaHistory(id)` | Schema version history (append-only hash chain) |
| `getCollectionNfts(id, params?)` | NFTs in collection |
| `getCollectionStats(id)` | Collection statistics |
| `getNft(id)` | NFT by ID |
| `getNftOwner(id)` | Fast current-owner claim from `/api/nfts/:id/owner` |
| `getNftOwnership(id)` | Canonical ownership proof from `/api/nfts/:id/ownership` |
| `getNftProof(id)` | Compatibility alias for the ownership proof contract used by SPV verification |
| `getNftLoan(id)` | Active loan custody for an NFT, separate from ownership |
| `getNftInstances(id, params?)` | Instances from seed; supports `{ compact: true }` for reduced payloads |
| `getUserAssets(username, params?)` | Dashboard overview of owned NFTs, seeds, loans, and collections |
| `getUserNfts(username, params?)` | User's NFTs with counts |
| `getUserNftCounts(username)` | NFT counts by type |
| `getUserCollections(username, params?)` | Collections created by a user |
| `getUserLoans(username, params?)` | Active loans by role (`lender`, `borrower`, or `all`) |
| `getListings(params?)` | Marketplace listings |
| `getSales(params?)` | Completed sales with financial breakdown |
| `getSalesVolume(params?)` | Aggregated marketplace volume statistics |
| `getOperationStatus(txId, params?)` | Per-operation status for a Hive transaction |
| `getPaymentInfo(nftId)` | Payment split for buy |
| `multisig(request)` | Request multisig signing |

Compatibility helpers still available:
- `getVolume(params?)` forwards to `getSalesVolume(params?)`

### Zod Schemas

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

`IndexerCollection` includes `status: "active" | "archived"`. Archived collections are hard-deleted and tracked in `archived_collections` (id, creator, tx_id) — full details are derivable from the transaction on-chain.

### SPV Verification ("Boleto Suizo")

Trustless verification -- the browser reads Hive L1 directly and replays deterministic logic to verify the indexer. NFT ownership verification uses the compact proof contract anchored by `owner_operation_id`: the SDK fetches the indexer snapshot, resolves that operation through HAFAH, derives the real owner from the on-chain `custom_json`, and compares it with the reported owner and previous owner.

| Function | Description |
|----------|-------------|
| `verifyNftOwnership(params)` | Verify the current ownership proof from the NFT's canonical ownership edge |
| `verifyOperationOnChain(params)` | Verify any operation exists on L1 |
| `fetchTransaction(config, txId)` | Fetch tx from HAFAH REST API |
| `parseNftloxOperation(tx)` | Parse NFTLox custom_json from tx |
| `verifyDeterministicDerivation(params)` | Verify instanceId/DNA/accessKey derivation |

### DNA & ID Generation

| Function | Description |
|----------|-------------|
| `generateOriginDna()` | Collection-level DNA (async) |
| `generateInstanceDna()` | NFT-level DNA |
| `generateDeterministicAccessKey()` | Verify access key post-broadcast (instanceDna, owner, txId) |
| `generateDeterministicCollectionId()` | Deterministic collection ID |
| `generateDeterministicSeedId()` | Deterministic seed ID |
| `generateDeterministicInstanceId()` | Deterministic instance ID |
| `isSeedId()` / `isInstanceId()` | ID type checks |

Ownership proof fields:
- `owner_operation_id`: authoritative operation anchor resolved through HAFAH/Hive L1.
- `owner_action`: one of `mint`, `bulk_distribute`, `transfer`, `nft_transfer_from`, `buy`.
- `owner_block_num`: Hive block context for ordering and diagnostics; not unique proof by itself.
- `claim_hash`: deterministic hash over the current owner claim fields.

### Types

All TypeScript interfaces are exported: `CollectionData`, `NFTData`, `ProtocolPayload`, `Price`, `HiveOperation`, `NftLendData`, `BuyData`, `PaymentInfo`, `MultisigRequest`, `MultisigResponse`, `BuildResult`, `ValidationError`, `IndexerNftOwner`, `IndexerNftProof`, `IndexerNftLoan`, `UserAssetsOverview`, and more.

## Entity Hierarchy

```
Collection
  +-- Seed (master NFT, maxSupply = N)
  |     +-- Instance #1 (distributed copy)
  |     +-- Instance #2
  |     +-- Instance #N
```

## Testing

```bash
bun test
```

## License

MIT

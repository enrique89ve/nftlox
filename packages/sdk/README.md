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
	runAudit,
	createAuditorConfig,
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
	maxReplicas: 100,
});

// 3. Lend an NFT (protocol-level, owner keeps ownership)
const lendOp = createNftLendOperation(
	{ instanceId: "nft_abc123", borrower: "bob" },
	"alice", // owner signs with active key
);

// 4. Buy an NFT via multisig
const info = await fetchPaymentInfo("https://indexer.nftlox.com", "nft_xyz");
const result = await requestMultisig("https://indexer.nftlox.com", {
	buyer: "alice",
	nftId: "nft_xyz",
	transaction: unsignedTx,
});

// 5. SPV Audit -- verify indexer isn't lying
const config = createAuditorConfig({
	indexerBaseUrl: "https://indexer.nftlox.com",
	sampleSize: 3,
});
const report = await runAudit(config);
console.log(report.verified, "of", report.samplesChecked, "verified");
```

## API Reference

### Constants

| Export | Description |
|--------|-------------|
| `PROTOCOL_ID` | `"nftlox_testnet"` |
| `PROTOCOL_VERSION` | `"0.4.1"` |
| `ALL_ACTIONS` | All 26 protocol actions |
| `CORE_ACTIONS` | 10 core actions |
| `MARKETPLACE_ACTIONS` | 3 marketplace actions (list, unlist, buy) |
| `PACK_ACTIONS` | 4 pack actions |
| `APPROVE_ACTIONS` | 5 approve/transferFrom actions |
| `LENDING_ACTIONS` | 2 lending actions (nft_lend, nft_return) |
| `DATA_OPERATOR_ACTIONS` | 2 data operator actions |
| `SUPPORTED_CURRENCIES` | `["HIVE", "HBD"]` |
| `PROTOCOL_FEE_PCT` | `1.0` (protocol fee percentage, 1% on sales) |
| `calculatePaymentSplit()` | Compute seller/royalty/fee split for a sale |

### Payload Creators

| Function | Description |
|----------|-------------|
| `createDeterministicCollectionPayload()` | Create collection (deterministic ID) |
| `createDeterministicMintPayload()` | Mint seed/NFT (deterministic ID) |
| `createBulkDistributePayload()` | Bulk distribute instances from seed (`seedTxId` per item) |
| `createTransferPayload()` | Transfer NFT |
| `createBurnPayload()` | Burn NFT |
| `createReplicatePayload()` | Create replica |
| `createSetDataPayload()` | Update custom data/tags |
| `createArchiveCollectionPayload()` | Archive an empty collection |
| `createListPayload()` | List on marketplace |
| `createUnlistPayload()` | Remove listing |
| `createBuyPayload()` | Buy listed NFT (multisig) |
| `createPackCreatePayload()` | Create pack |
| `createPackBuyPayload()` | Buy pack |
| `createPackTransferPayload()` | Transfer pack |
| `createPackOpenPayload()` | Open pack |
| `createNftApprovePayload()` | Approve spender for NFT |
| `createNftApproveAllPayload()` | Approve spender for collection |
| `createNftTransferFromPayload()` | Transfer as approved spender |
| `createPackApprovePayload()` | Approve pack spending |
| `createPackTransferFromPayload()` | Transfer pack as spender |
| `createNftLendPayload()` | Lend NFT to borrower |
| `createNftReturnPayload()` | Return lent NFT |
| `createDataOperatorApprovePayload()` | Approve data operator |
| `createSetDataFromPayload()` | Write data as operator |

Each payload creator has a matching `create*Operation()` that wraps it in a `custom_json` Hive operation tuple.

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
| `buildBurn()` | Validate + build burn |
| `buildSetData()` | Validate + build set-data |
| `buildArchiveCollection()` | Validate + build collection archive |
| `buildSetDataFrom()` | Validate + build set-data-from |
| `buildPackCreate()` | Validate + build pack create |
| `buildPackBuy()` | Validate + build pack buy |
| `buildPackTransfer()` | Validate + build pack transfer |
| `buildPackOpen()` | Validate + build pack open |
| `buildNftApprove()` | Validate + build NFT approve |
| `buildNftApproveAll()` | Validate + build collection-wide approve |
| `buildNftTransferFrom()` | Validate + build NFT transfer-from |
| `buildPackApprove()` | Validate + build pack approve |
| `buildPackTransferFrom()` | Validate + build pack transfer-from |
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
const nft = await indexer.getNft("nft_abc123");
```

| Method | Description |
|--------|-------------|
| `getStatus()` | Sync status |
| `getHealth()` | Health check |
| `getStats()` | Protocol statistics |
| `getCollections(params?)` | List collections |
| `getCollection(id)` | Active collection by ID |
| `getCollectionNfts(id, params?)` | NFTs in collection |
| `getCollectionStats(id)` | Collection statistics |
| `getNft(id)` | NFT by ID |
| `getNftInstances(id, params?)` | Instances from seed |
| `getUserNfts(username, params?)` | User's NFTs with counts |
| `getUserNftCounts(username)` | NFT counts by type |
| `getUserCollections(username, params?)` | User's collections |
| `getUserPacks(username, params?)` | User's pack balances |
| `getListings(params?)` | Marketplace listings |
| `getPaymentInfo(nftId)` | Payment split for buy |
| `multisig(request)` | Request multisig signing |
| `getPacks(params?)` | List packs |
| `getPack(id)` | Pack by ID |

### Zod Schemas

Exported from `schemas.ts`. Each schema validates input for its corresponding action.

| Schema | Description |
|--------|-------------|
| `createCollectionInputSchema` | Collection creation |
| `mintInputSchema` | Mint input |
| `listInputSchema` | List input |
| `unlistInputSchema` | Unlist input |
| `burnInputSchema` | Burn input |
| `replicateInputSchema` | Replicate input |
| `bulkDistributeInputSchema` | Bulk distribute input |
| `setDataInputSchema` | Set data input |
| `dataOperatorApproveInputSchema` | Data operator approve |
| `setDataFromInputSchema` | Set data from input |
| `packCreateInputSchema` | Pack create input |
| `packBuyInputSchema` | Pack buy input |
| `packTransferInputSchema` | Pack transfer input |
| `packOpenInputSchema` | Pack open input |
| `packApproveInputSchema` | Pack approve input |
| `packTransferFromInputSchema` | Pack transfer-from input |
| `nftApproveInputSchema` | NFT approve input |
| `nftApproveAllInputSchema` | NFT approve-all input |
| `nftTransferFromInputSchema` | NFT transfer-from input |
| `nftLendInputSchema` | NFT lend input |
| `nftReturnInputSchema` | NFT return input |
| `atomicTransferInputSchema` | Atomic transfer input |
| `usernameSchema` | Hive username validation |
| `priceSchema` | Price object validation |

`IndexerCollection` includes an explicit `status: "active" | "archived"` plus archive metadata fields (`archived_at_block`, `archived_tx_id`, `archived_at`). Public indexer collection queries only return active collections.

### SPV Verification ("Boleto Suizo")

Trustless verification -- the browser reads Hive L1 directly and replays deterministic logic to verify the indexer.

| Function | Description |
|----------|-------------|
| `runAudit(config)` | Random sample audit of pack_open events |
| `runSingleVerification(config, txId, blockNum)` | Verify a specific pack_open |
| `verifyNftOwnership(params)` | Verify NFT ownership chain (samples up to 3 events) |
| `verifyOperationOnChain(params)` | Verify any operation exists on L1 |
| `fetchTransaction(config, txId)` | Fetch tx from HAFAH REST API |
| `parseNftloxOperation(tx)` | Parse NFTLox custom_json from tx |
| `replayDropTableResolution(params)` | Replay RNG locally (pure function) |
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
| `generateDeterministicPackId()` | Deterministic pack ID |
| `resolveDropTable()` | Deterministic RNG drop table resolution |
| `isSeedId()` / `isInstanceId()` / `isPackId()` | ID type checks |

### Types

All TypeScript interfaces are exported: `CollectionData`, `NFTData`, `ProtocolPayload`, `Price`, `HiveOperation`, `PackDropEntry`, `NftLendData`, `BuyData`, `PaymentInfo`, `MultisigRequest`, `MultisigResponse`, `PackOpenVerificationResult`, `AuditReport`, `BuildResult`, `ValidationError`, and more.

## Entity Hierarchy

```
Collection
  +-- Seed (master NFT, maxReplicas = N)
  |     +-- Instance #1 (distributed copy)
  |     +-- Instance #2
  |     +-- Instance #N
  +-- Pack (semi-fungible, contains drop table)
        +-- pack_open -> resolves RNG -> mints instances
```

## Testing

```bash
bun test
```

## License

MIT

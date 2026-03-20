# NFTLox SDK

Core protocol library for **NFTLox** — a Polymorphic Ownership infrastructure on Hive blockchain. Enables emitting digital assets with "functional DNA" that separates economic ownership from logical utility, without smart contracts.

## Installation

```bash
bun add nftlox-sdk
```

## Quick Start

```typescript
import {
  createDeterministicCollectionPayload,
  createDeterministicMintPayload,
  createDistributePayload,
  createTransferPayload,
  createNftLendOperation,
  createNftReturnOperation,
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

// 4. SPV Audit — verify indexer isn't lying
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
| `PROTOCOL_VERSION` | `"0.2.1"` |
| `ALL_ACTIONS` | All 29 protocol actions |
| `CORE_ACTIONS` | 7 core actions |
| `MARKETPLACE_ACTIONS` | 6 marketplace actions |
| `PACK_ACTIONS` | 4 pack actions |
| `APPROVE_ACTIONS` | 5 approve/transferFrom actions |
| `LENDING_ACTIONS` | 2 lending actions (nft_lend, nft_return) |
| `DATA_OPERATOR_ACTIONS` | 2 data operator actions |

### Payload Creators

| Function | Description |
|----------|-------------|
| `createCollectionPayload()` | Create collection (random ID) |
| `createDeterministicCollectionPayload()` | Create collection (deterministic ID) |
| `createMintPayload()` | Mint NFT (random ID) |
| `createDeterministicMintPayload()` | Mint NFT (deterministic ID) |
| `createDistributePayload()` | Distribute instance from seed |
| `createTransferPayload()` | Transfer NFT |
| `createBurnPayload()` | Burn NFT |
| `createReplicatePayload()` | Create replica |
| `createSetDataPayload()` | Update custom data/tags |
| `createListPayload()` | List on marketplace |
| `createUnlistPayload()` | Remove listing |
| `createBuyPayload()` | Buy listed NFT |
| `createOfferPayload()` | Make offer |
| `createAcceptOfferPayload()` | Accept offer |
| `createRejectOfferPayload()` | Reject offer |
| `createPackCreatePayload()` | Create pack |
| `createPackBuyPayload()` | Buy pack |
| `createPackTransferPayload()` | Transfer pack |
| `createPackOpenPayload()` | Open pack |
| `createNftApprovePayload()` | Approve spender for NFT |
| `createNftLendPayload()` | Lend NFT to borrower |
| `createNftReturnPayload()` | Return lent NFT |
| `createDataOperatorApprovePayload()` | Approve data operator |

### SPV Verification ("Boleto Suizo")

Trustless verification — the browser reads Hive L1 directly and replays deterministic logic to verify the indexer.

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
| `generateAccessKey()` | Unique access key |
| `generateDeterministicCollectionId()` | Deterministic collection ID |
| `generateDeterministicSeedId()` | Deterministic seed ID |
| `generateDeterministicInstanceId()` | Deterministic instance ID |
| `generateDeterministicPackId()` | Deterministic pack ID |
| `resolveDropTable()` | Deterministic RNG drop table resolution |
| `isSeedId()` / `isInstanceId()` / `isPackId()` | ID type checks |

### Validation

| Function | Description |
|----------|-------------|
| `validateCollectionInput()` | Validate collection creation |
| `validateMintInput()` | Validate mint |
| `validatePrice()` | Validate price object |
| `validatePackCreateInput()` | Validate pack creation |
| `validatePackOpenInput()` | Validate pack open |
| `validateNftLendInput()` | Validate lend |
| `validateNftReturnInput()` | Validate return |
| `splitIntoBatches()` | Split items into TX batches |

### Types

All TypeScript interfaces are exported: `CollectionData`, `NFTData`, `ProtocolPayload`, `Price`, `HiveOperation`, `PackDropEntry`, `NftLendData`, `PackOpenVerificationResult`, `AuditReport`, and more.

## Entity Hierarchy

```
Collection
  ├── Seed (master NFT, maxReplicas = N)
  |     ├── Instance #1 (distributed copy)
  |     ├── Instance #2
  |     └── Instance #N
  └── Pack (semi-fungible, contains drop table)
        └── pack_open → resolves RNG → mints instances
```

## Testing

```bash
bun test
```

## License

MIT

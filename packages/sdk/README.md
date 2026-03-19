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
  createAtomicTransferOperations,
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

// 3. Distribute an instance
const instance = createDistributePayload({
  seedId: seed.data.id,
  to: "recipient",
  instanceNumber: 1,
});

// 4. Transfer with atomic notification (0.001 HIVE)
const ops = createAtomicTransferOperations({
  nftId: "seed_xxx",
  collectionId: "col_xxx",
  edition: 1,
  instanceDna: "...",
  from: "sender",
  to: "recipient",
});
```

## API Reference

### Constants

| Export | Description |
|--------|-------------|
| `PROTOCOL_ID` | `"nftlox_testnet"` |
| `PROTOCOL_VERSION` | `"0.2.1"` |
| `MIN_PROTOCOL_VERSION` | `"0.2.0"` |
| `ALL_ACTIONS` | All 13 protocol actions |
| `CORE_ACTIONS` | 7 core actions |
| `MARKETPLACE_ACTIONS` | 6 marketplace actions |

### Payload Creators

| Function | Description |
|----------|-------------|
| `createCollectionPayload()` | Create collection (random ID) |
| `createDeterministicCollectionPayload()` | Create collection (deterministic ID) |
| `createMintPayload()` | Mint NFT (random ID) |
| `createDeterministicMintPayload()` | Mint NFT (deterministic ID) |
| `createDistributePayload()` | Distribute instance from seed |
| `createDeterministicDistributePayload()` | Distribute (deterministic ID) |
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

### Hive Operations

| Function | Description |
|----------|-------------|
| `createAtomicTransferOperations()` | Build transfer + custom_json pair |
| `buildTransferMemo()` | Build nftlox memo string |
| `parseTransferMemo()` | Parse nftlox memo |
| `getTrackingAmount()` | Returns "0.001 HIVE" |

### DNA & ID Generation

| Function | Description |
|----------|-------------|
| `generateOriginDna()` | Collection-level DNA (async) |
| `generateInstanceDna()` | NFT-level DNA |
| `generateAccessKey()` | Unique access key |
| `generateImageHash()` | Image hash from URL |
| `generateDeterministicCollectionId()` | Deterministic collection ID |
| `generateDeterministicSeedId()` | Deterministic seed ID |
| `generateDeterministicInstanceId()` | Deterministic instance ID |
| `isSeedId()` / `isInstanceId()` / `isReplicaId()` | ID type checks |

### Validation

| Function | Description |
|----------|-------------|
| `validateCollectionInput()` | Validate collection creation input |
| `validateMintInput()` | Validate mint input |
| `validatePrice()` | Validate price object |
| `validateSymbol()` | Validate collection symbol |
| `estimateOperationSize()` | Estimate JSON size |
| `splitIntoBatches()` | Split items into TX batches |

### Types

All TypeScript interfaces are exported: `CollectionData`, `NFTData`, `ProtocolPayload`, `Price`, `HiveOperation`, `AtomicTransferInput`, `HistoryEvent`, `OwnershipRecord`, and more.

## Entity Hierarchy

```
Collection
  └── Seed (master NFT, maxReplicas = N)
        ├── Instance #1 (distributed copy)
        ├── Instance #2
        └── Instance #N
```

## Related Projects

- [nftlox-indexer](https://github.com/enrique89ve/nftlox-indexer) — Blockchain indexer + REST API
- [nftlox-playground](https://github.com/enrique89ve/nftlox-playground) — Web UI for testing

## Testing

```bash
bun test
```

## License

MIT

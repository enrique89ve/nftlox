# @nftlox/sdk

> Core NFTLox protocol library — typed payloads, builders, Zod schemas, multisig signing, SPV verification.

## Install

```bash
bun add @nftlox/sdk
```

## Quick start

```typescript
import {
	initProtocol,
	buildCollection,
	buildSeed,
	buildBulkDistribute,
	buildTransfer,
} from "@nftlox/sdk";

// Initialize from the indexer API (call once at startup)
await initProtocol("https://api-nftlox.hivecreators.co");

// Build a collection (Zod-validated, returns payload + generatedId)
const col = buildCollection({
	name: "My Collection",
	symbol: "MYCOL",
	signer: "alice",
	totalPotential: 1000,
	metadata: { description: "...", image: "https://..." },
	rules: { transferable: true, burnable: true, royaltyPct: 5 },
});

// Build a seed
const seed = buildSeed({
	artId: "unique-art-id",
	collectionId: col.generatedId,
	collectionOriginDna: col.payload.data.originDna,
	signer: "alice",
	name: "NFT Name",
	imageUrl: "https://...",
	maxSupply: 100,
});

// Each builder returns { payload, operation, generatedId?, warnings? }
// `operation` is a Hive custom_json tuple ready to broadcast.
```

## Main exports

The SDK re-exports the wire protocol from `@nftlox/protocol` and adds builders, clients, SPV, and validation.

| Category | Key exports |
|---|---|
| **Protocol constants** | `PROTOCOL_ID`, `PROTOCOL_VERSION`, `ALL_ACTIONS`, `CORE_ACTIONS`, `MARKETPLACE_ACTIONS`, `SUPPORTED_CURRENCIES`, `PROTOCOL_FEE_BPS` |
| **Action constants** | `ACTION_MINT`, `ACTION_TRANSFER`, `ACTION_LIST`, `ACTION_BUY`, `ACTION_BULK_DISTRIBUTE`, … (19 total) |
| **Auth helpers** | `isProtocolAction()`, `getAuthLevel()`, `getKeyType()`, `ACTION_AUTH_LEVEL` |
| **Payment** | `calculatePaymentSplit()`, `calculateBasisPointsAmount()` |
| **Builders** | `buildCollection()`, `buildSeed()`, `buildSeedBatch()`, `buildBulkDistribute()`, `buildTransfer()`, `buildList()`, `buildBuy()`, `buildSetData()`, `buildNftLend()`, `buildNftReturn()`, `buildNodeHeartbeat()`, … |
| **Zod schemas** | `createCollectionInputSchema`, `mintInputSchema`, `bulkDistributeInputSchema`, `listInputSchema`, … |
| **Multisig client** | `fetchPaymentInfo()`, `requestBuyMultisig()`, `requestCreateCollectionMultisig()` |
| **SPV verification** | `verifyNftOwnership()`, `verifyOperationOnChain()`, `fetchTransaction()` |
| **Indexer client** | `createIndexerClient()` — portable `fetch()`-based client (browser + Node + Bun) |
| **Protocol state** | `initProtocol()`, `makePayload()`, `getProtocolVersion()`, `isInitialized()` |
| **DNA / ID generation** | `generateOriginDna()`, `generateInstanceDna()`, `generateDeterministicCollectionId()`, `generateDeterministicSeedId()`, `isSeedId()`, `isInstanceId()` |
| **Art ID** | `sanitizeArtId()`, `generateArtIdFromName()`, `validateArtId()` |
| **Schema templates** | `GAMING_SCHEMA`, `ART_SCHEMA`, `COLLECTIBLE_SCHEMA`, `createSchemaBuilder()` |
| **Types** | `ProtocolPayload`, `CollectionData`, `NFTData`, `Price`, `BuildResult`, `MultisigResponse`, `IndexerNft`, `UserAssetsOverview`, … |

Full export list and reference: [`packages/playground/docs/sdk-functions.md`](../playground/docs/sdk-functions.md).

## Protocol initialization

```typescript
import { initProtocol, makePayload } from "@nftlox/sdk";

await initProtocol("https://api-nftlox.hivecreators.co");

// makePayload() injects the correct protocol ID and version automatically
const payload = makePayload("transfer", { instanceId: "nft_abc123", to: "bob" });
```

- `initProtocol(baseUrl?)` fetches the current protocol version and ID from `/api/status`.
- Call **once at startup**, before creating any payloads.
- If not called, the SDK falls back to built-in `PROTOCOL_ID` / `PROTOCOL_VERSION` constants (offline mode).

## Compatibility

Runs on **Node.js** and **Bun**. Browser-safe — no Node-only APIs in the public surface.

## Entity hierarchy

```
Collection
  └── Seed (master NFT, maxSupply = N)
        ├── Instance #1 (distributed copy, unique DNA)
        ├── Instance #2
        └── Instance #N
```

## Documentation

- [Getting Started](../playground/docs/getting-started.md) — first API call and first mint.
- [SDK Functions reference](../playground/docs/sdk-functions.md) — full exports table.
- [Game Integration](../playground/docs/game-integration.md) — game-developer walkthrough.
- [Broadcasting](../playground/docs/broadcasting.md) — signing and broadcasting payloads.
- [SPV Verification](../playground/docs/spv-verification.md) — trustless ownership proofs.

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build the package |
| `bun run test` | Run all SDK tests |
| `bun run typecheck` | TypeScript type check |

## License

MIT

# nftlox-sdk

> NFTLox builder and client library — payload builders, Zod schemas, multisig signing, SPV verification, and indexer queries. The wire protocol source of truth lives in `@nftlox/protocol`.

## Install

To test the SDK today, clone the repository and install from the workspace root:

```bash
git clone https://github.com/enrique89ve/nftlox.git nftlox
cd nftlox
bun install
bun run --filter nftlox-sdk typecheck
```

For an external project, install from npm once the package has been published:

```bash
bun add nftlox-sdk
# or
npm install nftlox-sdk
# or
pnpm add nftlox-sdk
```

External npm consumers also need `@nftlox/protocol` to be published. The published SDK is shaped for both runtimes: Node.js loads compiled ESM from `dist/index.js`, TypeScript reads `dist/index.d.ts`, and Bun can load TypeScript source through the `bun` export condition.

Before npm publication, the cleanest way for a game to test the SDK is to create a temporary package inside this monorepo under `packages/` and depend on the workspace packages:

```json
{
	"name": "game-sdk-smoke",
	"private": true,
	"type": "module",
	"dependencies": {
		"nftlox-sdk": "workspace:*",
		"nftlox-packs-engine": "workspace:*"
	}
}
```

See [`packages/playground/docs/guides/game-bot-testing.md`](../playground/docs/guides/game-bot-testing.md) for the full bot testing flow.

## Quick start

```typescript
import {
	initProtocol,
	buildCollection,
	buildSeed,
	buildBulkDistribute,
	buildTransfer,
	fetchMultisigNodeAccount,
} from "nftlox-sdk";

const INDEXER_URL = "https://api-nftlox.hivecreators.co";

// Initialize from the indexer API (call once at startup)
await initProtocol(INDEXER_URL);

const nodeAccount = await fetchMultisigNodeAccount(INDEXER_URL);
console.log(`Node co-signer: ${nodeAccount}`);

// Build a collection (Zod-validated, returns transfer + custom_json operations)
const col = await buildCollection(
	{
		name: "My Collection",
		symbol: "MYCOL",
		creator: "alice",
		totalPotential: 1000,
		metadata: { description: "...", image: "https://example.com/cover.png" },
		rules: { transferable: true, burnable: true, royaltyPct: 5 },
	},
	{ indexerBaseUrl: INDEXER_URL, feeCurrency: "HBD", feeAmount: "0.100" },
);

if (!col.success) {
	throw new Error(`Collection build failed: ${JSON.stringify(col.errors)}`);
}

// Build a seed
const seed = await buildSeed({
	artId: "unique-art-id",
	collectionId: col.generatedIds.collectionId,
	signer: "alice",
	name: "NFT Name",
	imageUrl: "https://example.com/nft.png",
	maxSupply: 100,
	edition: 1,
});

if (!seed.success) {
	throw new Error(`Seed build failed: ${JSON.stringify(seed.errors)}`);
}

// Each builder returns { payload, operations, generatedIds?, warnings? }.
// Collection creation includes a fee transfer and a node co-signed custom_json.
```

## Main exports

The SDK re-exports the wire protocol from `@nftlox/protocol` and adds builders, clients, SPV, and validation.

| Category | Key exports |
|---|---|
| **Protocol constants** | `PROTOCOL_ID`, `PROTOCOL_VERSION`, `ALL_ACTIONS`, `CORE_ACTIONS`, `MARKETPLACE_ACTIONS`, `SUPPORTED_CURRENCIES`, `PROTOCOL_FEE_BPS` |
| **Action constants** | `ACTION_MINT`, `ACTION_TRANSFER`, `ACTION_LIST`, `ACTION_SALE_LOCK`, `ACTION_BUY`, `ACTION_BULK_DISTRIBUTE`, … (20 total) |
| **Auth helpers** | `isProtocolAction()`, `getAuthLevel()`, `getKeyType()`, `ACTION_AUTH_LEVEL` |
| **Payment** | `calculatePaymentSplit()`, `calculateBasisPointsAmount()` |
| **Builders** | `buildCollection()`, `buildExtendSchema()`, `buildArchiveCollection()`, `buildSeed()`, `buildSeedBatch()`, `buildCollectionWithSeeds()`, `buildBulkDistribute()`, `buildTransfer()`, `buildList()`, `buildBuy()`, `buildSetData()`, `buildSetDataFrom()`, `buildNftApprove()`, `buildNftApproveAll()`, `buildNftTransferFrom()`, `buildNftLend()`, `buildNftReturn()`, `buildNodeRegister()`, `buildNodeHeartbeat()`, `buildDataOperatorApprove()`, `buildBurn()` |
| **Zod schemas** | `createCollectionInputSchema`, `mintInputSchema`, `bulkDistributeInputSchema`, `listInputSchema`, … |
| **Multisig / buy client** | `fetchNodeAccount()`, `fetchMultisigNodeAccount()`, `resolveNodeAccountFromStatus()`, `fetchPaymentInfo()`, `submitBuy()`, `requestCreateCollectionMultisig()` |
| **SPV verification** | `verifyNftOwnership()`, `verifyOperationOnChain()`, `fetchTransaction()` |
| **Indexer client** | `createIndexerClient()` — portable `fetch()`-based client with `getNodeAccount()` and `getMultisigNodeAccount()` helpers |
| **Protocol state** | `initProtocol()`, `makePayload()`, `getProtocolVersion()`, `isInitialized()` |
| **DNA / ID generation** | `generateOriginDna()`, `generateSeedDna()`, `generateInstanceDna()`, `generateDeterministicCollectionId()`, `generateDeterministicSeedId()`, `isSeedId()`, `isInstanceId()` |
| **Art ID** | `sanitizeArtId()`, `generateArtIdFromName()`, `validateArtId()` |
| **Schema templates** | `GAMING_SCHEMA`, `ART_SCHEMA`, `COLLECTIBLE_SCHEMA`, `createSchemaBuilder()` |
| **Types** | `ProtocolPayload`, `CollectionData`, `NFTData`, `Price`, `KeychainResult`, `CollectionCreationPlan`, `MultisigResponse`, `IndexerNft`, `UserAssetsOverview`, … |

Full export list and reference: [`packages/playground/docs/sdk/reference.md`](../playground/docs/sdk/reference.md).

## Protocol initialization

```typescript
import { initProtocol, makePayload } from "nftlox-sdk";

await initProtocol("https://api-nftlox.hivecreators.co");

// makePayload() injects the correct protocol ID and version automatically
const payload = makePayload("transfer", { instanceId: "nft_abc123", to: "bob" });
```

- `initProtocol(baseUrl?)` fetches the current protocol version and ID from `/api/status`.
- Call **once at startup**, before creating any payloads.
- If not called, the SDK falls back to built-in `PROTOCOL_ID` / `PROTOCOL_VERSION` constants (offline mode).

## Compatibility

The package supports **Node.js and Bun**. Node.js uses the compiled ESM entry at `dist/index.js`; Bun uses the `bun` export condition and can execute `src/index.ts` directly. The public SDK surface avoids Node-only APIs.

## Entity hierarchy

```
Collection
  └── Seed (master NFT, maxSupply = N)
        ├── Instance #1 (distributed copy, unique DNA)
        ├── Instance #2
        └── Instance #N
```

## Documentation

- [Protocol Operations](../protocol/README.md) — canonical action list, constants, authority map, and base operations.
- [Getting Started](../playground/docs/getting-started.md) — first API call and first mint.
- [SDK Functions reference](../playground/docs/sdk/reference.md) — full exports table.
- [Game Integration](./GAME-INTEGRATION.md) — game-developer walkthrough.
- [Broadcasting](../playground/docs/broadcasting.md) — signing and broadcasting payloads.
- [SPV Verification](../playground/docs/guides/spv.md) — trustless ownership proofs.

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build the package |
| `bun run test` | Run all SDK tests |
| `bun run typecheck` | TypeScript type check |

## License

MIT

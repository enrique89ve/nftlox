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

The recommended entry point is `createNftloxClient`, which bundles the
indexer client, builders, SPV verifiers, and protocol metadata behind one
configured object so you do not have to wire `baseUrl` / `l1Config` into
every call.

```typescript
import { createNftloxClient, expireIn } from "nftlox-sdk";

const client = createNftloxClient({
	indexerUrl: "https://api-nftlox.hivecreators.co",
});

// (optional) Sync the SDK's protocol version with the live indexer.
await client.connect();

// Read the indexer.
const inventory = await client.indexer.getUserNfts("alice");

// Build an unsigned `list` operation. Always pass `expiresAt` inside the
// protocol's [7, 60]-day window — `expireIn` is a small ergonomic helper.
const listing = await client.builders.list({
	nftId: inventory.nfts[0]!.id,
	owner: "alice",
	price: { amount: "10.000", currency: "HIVE" },
	expiresAt: expireIn({ days: 14 }),
});
if (!listing.success) throw new Error(JSON.stringify(listing.errors));

// You sign + broadcast `listing.operations` with Hive Keychain (browser),
// @hiveio/wax, or hive-tx. The SDK never touches private keys.

// Trustless verification of an existing listing against Hive L1 — useful
// for apps that don't want to trust the indexer's projection.
const proof = await client.spv.verifyNftOwnership({
	nftId: inventory.nfts[0]!.id,
	expectedOwner: "alice",
});
console.log(proof.status); // "verified" | "mismatch" | ...
```

A complete runnable walkthrough lives at
[`examples/quick-game.ts`](./examples/quick-game.ts) — read-only Part A
queries the live indexer with no signing, Part B shows distribute → list
with a stubbed signer.

The lower-level surface (`buildCollection`, `buildSeed`, `createIndexerClient`,
the SPV functions) is still exported at the package root for callers who
prefer to wire the modules themselves.

## Main exports

The SDK re-exports a curated subset of `@nftlox/protocol` (see `src/protocol-exports.ts` for the exact list) and adds builders, clients, SPV, and validation. The re-export surface is curated on purpose: adding a symbol is an opt-in semver commitment, so protocol-internal helpers (e.g. DNA-prefix constants) stay internal until a concrete integrator need appears.

| Category | Key exports |
|---|---|
| **Protocol identity** | `PROTOCOL_ID`, `PROTOCOL_VERSION`, `MIN_PROTOCOL_VERSION`, `HASH_VERSION` |
| **Hive platform** | `HIVE_BLOCK_TIME_MS`, `HIVE_DECIMALS`, `HIVE_PRECISION`, `HIVE_AMOUNT_EPSILON` |
| **Action constants (20)** | `ACTION_CREATE_COLLECTION`, `ACTION_MINT`, `ACTION_TRANSFER`, `ACTION_BULK_DISTRIBUTE`, `ACTION_SET_DATA`, `ACTION_EXTEND_SCHEMA`, `ACTION_ARCHIVE_COLLECTION`, `ACTION_NODE_REGISTER`, `ACTION_NODE_HEARTBEAT`, `ACTION_LIST`, `ACTION_UNLIST`, `ACTION_BUY_COMMITMENT`, `ACTION_BUY`, `ACTION_NFT_APPROVE`, `ACTION_NFT_APPROVE_ALL`, `ACTION_NFT_TRANSFER_FROM`, `ACTION_NFT_LEND`, `ACTION_NFT_RETURN`, `ACTION_DATA_OPERATOR_APPROVE`, `ACTION_SET_DATA_FROM` |
| **Action groups** | `ALL_ACTIONS`, `CORE_ACTIONS`, `MARKETPLACE_ACTIONS`, `APPROVE_ACTIONS`, `LENDING_ACTIONS`, `DATA_OPERATOR_ACTIONS`, `ACTIVE_AUTH_ACTIONS`, `POSTING_AUTH_ACTIONS`, `NODE_SIGNED_ACTIONS` |
| **Auth helpers** | `isProtocolAction()`, `getAuthLevel()`, `getKeyType()`, `getAuthMismatchReason()`, `requiresActiveNodeSigner()`, `ACTION_AUTH_LEVEL` |
| **Marketplace & fees** | `SUPPORTED_CURRENCIES`, `MAX_ROYALTY_PCT`, `MIN_PRICE_AMOUNT`, `PROTOCOL_FEE_BPS`, `PROTOCOL_COLLECTION_FEE_HBD`, `MIN_LISTING_TTL_MS`, `MIN_LISTING_TTL_BUFFER_MS`, `MAX_INSTANCES_PER_COLLECTION`, `MULTISIG_TX_MIN_EXPIRATION_MS`, `MULTISIG_TX_MAX_EXPIRATION_MS`, `RECOMMENDED_BUY_TX_EXPIRATION_MS` |
| **Memo tags & prefixes** | `MEMO_PREFIX_BUY`, `MEMO_PREFIX_ROYALTY`, `MEMO_PREFIX_FEE`, `MEMO_PREFIX_FEE_COL`, `MEMO_TAG_BUY`, `MEMO_TAG_ROYALTY`, `MEMO_TAG_FEE`, `MEMO_TAG_FEE_COL`, `BURN_RECIPIENT` |
| **Id/hash format** | `COLLECTION_ID_PREFIX`, `SEED_ID_PREFIX`, `INSTANCE_ID_PREFIX`, `IMAGE_ID_PREFIX`, `LISTING_ID_PREFIX`, `COLLECTION_ID_HASH_LENGTH`, `INSTANCE_ID_HASH_LENGTH`, `IMAGE_ID_HASH_LENGTH`, `HASH_FORMAT_PREFIX`, `HASH_DOMAIN_COL`, `HASH_DOMAIN_ORIGIN`, `HASH_DOMAIN_SEED`, `HASH_DOMAIN_DNA`, `HASH_DOMAIN_KEY`, `HASH_DOMAIN_SEED_DNA`, `HASH_DOMAIN_IMG`, `HASH_DOMAIN_LISTING` |
| **Payment math** | `calculatePaymentSplit()`, `calculateBasisPointsAmount()`, `percentageToBasisPoints()`, `roundHive()` |
| **Builders** | `buildCollection()`, `buildExtendSchema()`, `buildArchiveCollection()`, `buildSeed()`, `buildSeedBatch()`, `buildCollectionWithSeeds()`, `buildBulkDistribute()`, `buildTransfer()`, `buildList()`, `buildBuy()`, `buildSetData()`, `buildSetDataFrom()`, `buildNftApprove()`, `buildNftApproveAll()`, `buildNftTransferFrom()`, `buildNftLend()`, `buildNftReturn()`, `buildNodeRegister()`, `buildNodeHeartbeat()`, `buildDataOperatorApprove()`, `buildBurn()` |
| **Zod schemas** | `createCollectionInputSchema`, `mintInputSchema`, `bulkDistributeInputSchema`, `listInputSchema`, … |
| **Multisig / buy client** | `fetchNodeAccount()`, `fetchMultisigNodeAccount()`, `resolveNodeAccountFromStatus()`, `fetchPaymentInfo()`, `submitBuy()`, `requestCreateCollectionMultisig()` |
| **SPV verification** | `verifyNftOwnership()`, `verifyOperationOnChain()`, `fetchTransaction()` |
| **Indexer client** | `createIndexerClient()` — portable `fetch()`-based client with `getNodeAccount()` and `getMultisigNodeAccount()` helpers |
| **Protocol state** | `initProtocol()`, `makePayload()`, `getProtocolVersion()`, `isInitialized()` |
| **DNA / ID generation** | `generateOriginDna()`, `generateSeedDna()`, `generateInstanceDna()`, `generateImageHash()`, `generateDeterministicCollectionId()`, `generateDeterministicSeedId()`, `generateDeterministicInstanceId()`, `generateDeterministicAccessKey()`, `generateListingId()`, `isSeedId()`, `isInstanceId()`, `extractSeedId()`, `extractInstanceNumber()` |
| **Art ID** | `sanitizeArtId()`, `generateArtIdFromName()`, `validateArtId()` |
| **Schema templates** | `GAMING_SCHEMA`, `ART_SCHEMA`, `COLLECTIBLE_SCHEMA`, `createSchemaBuilder()` |
| **Types** | `ProtocolPayload`, `CollectionData`, `NFTData`, `Price`, `KeychainResult`, `CollectionCreationPlan`, `MultisigResponse`, `BuyCommitmentData`, `IndexerNft`, `UserAssetsOverview`, … |

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

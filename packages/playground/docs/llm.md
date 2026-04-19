# NFTLox — LLM Context Reference

Single-file reference for AI assistants. Covers the complete SDK, protocol actions, indexer API, and error codes. All code is real and runnable.

---

## Core concept in one paragraph

NFTLox is an NFT protocol on Hive L1. Every action is a Hive `custom_json` operation (or a transfer + custom_json for buys/collection creation). A public indexer reads L1, validates actions, and rebuilds state in PostgreSQL. The `nftlox-sdk` package constructs unsigned operations client-side. You sign them with your own Hive keys and broadcast to any Hive RPC node. The indexer **never** holds keys. Only two actions (`buy`, `create_collection`) require the indexer node to co-sign.

---

## Install

**Testnet phase** — packages not yet on npm. Clone the monorepo and use workspace references:

```bash
git clone https://github.com/enrique89ve/nftlox.git
cd nftlox && bun install
# Add your package under packages/ with "nftlox-sdk": "workspace:*"
```

Post-publish (future):

```bash
npm install nftlox-sdk hive-tx
# or: bun add nftlox-sdk hive-tx
```

`nftlox-sdk` re-exports everything from `@nftlox/protocol`. One import covers all builders, types, constants, and helpers.

---

## The KeychainResult contract

Every `build*` function returns:

```typescript
type KeychainResult<T> =
  | {
      success: true;
      operations: ReadonlyArray<HiveOperation | HiveTransferOperation>; // ready to sign
      keyType: "Active" | "Posting";     // which key the signer must use
      signer: string;                    // primary signer account
      coSigners?: readonly CoSigner[];   // present for create_collection and buy
      payload: ProtocolPayload<T>;       // the parsed custom_json body
      generatedIds?: Record<string, string>; // e.g. { collectionId, seedId, listingId }
      warnings?: readonly string[];
    }
  | {
      success: false;
      errors: readonly ValidationError[]; // [{ field, message, code }]
    };
```

**Rules:**
- Always check `success` before using any other field.
- `operations` is already in Hive tuple format `["custom_json", {...}]` or `["transfer", {...}]`.
- `keyType` is authoritative — never hardcode key types.
- Active key only for `create_collection` and `buy`. Everything else is posting.

---

## Three signer flows

### Flow 1 — Posting single-signer (17 of 20 actions)

```typescript
import { buildTransfer } from "nftlox-sdk";
import hive from "hive-tx";

const result = await buildTransfer({ nftId: "nft_…", from: "alice", to: "bob" });
if (!result.success) throw new Error(JSON.stringify(result.errors));

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.sign(hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!));
await tx.broadcast();
```

### Flow 2 — Active + node multisig (buy)

```typescript
import { buildBuy, createIndexerClient, MultisigError } from "nftlox-sdk";
import hive from "hive-tx";

const client = createIndexerClient("https://api-nftlox.hivecreators.co");
const info = await client.getPaymentInfo("nft_…");

const result = buildBuy({
  buyer: "bob",
  seller: info.seller,
  nftId: info.nftId,
  listingId: info.listingId,
  listTxId: info.listTxId,
  txId: info.txId,
  nodeAccount: info.nodeAccount,
  paymentSplit: {
    sellerAmount: info.sellerAmount,
    royaltyAmount: info.royaltyAmount,
    royaltyRecipient: info.royaltyRecipient,
    feeAmount: info.feeAmount,
    feeAccount: info.feeAccount,
    totalPrice: info.totalPrice,
    currency: info.currency as "HIVE" | "HBD",
  },
});
if (!result.success) throw new Error(JSON.stringify(result.errors));

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);

const resp = await client.multisig({
  buyer: "bob", nftId: info.nftId,
  listingId: info.listingId, listTxId: info.listTxId,
  transaction: tx.transaction,
});
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: "…" });

tx.transaction.signatures.push(resp.signature);
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));
await tx.broadcast();
```

### Flow 3 — Active + node multisig (create_collection)

```typescript
import { buildCollection, requestCreateCollectionMultisig, MultisigError } from "nftlox-sdk";
import hive from "hive-tx";

const result = await buildCollection(input, {
  indexerBaseUrl: "https://api-nftlox.hivecreators.co",
  requireMultisigReady: true,
});
if (!result.success) throw new Error(JSON.stringify(result.errors));

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);

const sig = await requestCreateCollectionMultisig("https://api-nftlox.hivecreators.co", {
  transaction: tx.transaction,
});
if (!sig.ok) throw new MultisigError({ message: sig.message, code: sig.code, url: "…" });

tx.transaction.signatures.push(sig.signature);
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));
await tx.broadcast();
```

---

## All builders

| Builder | Auth | Primary signer | What it does |
|---|---|---|---|
| `buildCollection` | Active | creator | Creates a collection + fee transfer. Requires node multisig. |
| `buildCollectionWithSeeds` | Active + Posting | creator | Plans collection step + batched seed mints together. |
| `buildSeed` | Posting | creator (of collection) | Mints a new seed template. `signer` = who signs; `owner` = where it lands (defaults to signer). |
| `buildBulkDistribute` | Posting | seed owner | Mints instances from seeds. `signer` = seed owner; `to` = recipient. |
| `buildTransfer` | Posting | NFT owner | Transfers an instance. |
| `buildBurn` | Posting | NFT owner | Burns an instance. |
| `buildList` | Posting | NFT owner | Lists an instance for sale. Generates `listingId` + `listingNonce`. |
| `buildUnlist` | Posting | NFT owner | Cancels a listing. |
| `buildBuy` | Active | buyer + node | Builds buy tx (buyer transfers + node-signed custom_json). Requires node multisig. |
| `buildSetData` | Posting | NFT owner | Updates mutable fields on an instance. Requires `instanceDna`. |
| `buildSetDataFrom` | Posting | approved data operator | Updates mutable fields on behalf of owner. Requires `instanceDna`. |
| `buildExtendSchema` | Posting | collection creator | Appends new fields to schema. Append-only. |
| `buildArchiveCollection` | Posting | collection creator | Permanently closes a collection (all NFTs must be burned first). |
| `buildNftApprove` | Posting | NFT owner | Grants a spender the right to transfer a single instance. |
| `buildNftApproveAll` | Posting | NFT owner | Grants a spender the right to transfer any instance in a collection. |
| `buildNftTransferFrom` | Posting | approved spender | Transfers using a prior approve/approve-all. |
| `buildDataOperatorApprove` | Posting | collection creator | Grants/revokes mutable-data write access to an operator account. |
| `buildNftLend` | Posting | NFT owner | Lends an instance. `owner ≠ borrower`. |
| `buildNftReturn` | Posting | current borrower | Returns a lent instance. Only the borrower can call this. |

---

## Builder input patterns

### buildSeed
```typescript
buildSeed({
  collectionId: "col_…",
  signer: "alice",          // required; who signs the tx
  artId: "warrior",         // slug; deterministic seed ID = sha256(collectionId, artId)
  name: "Warrior",
  imageUrl: "https://…",
  maxSupply: 1000,          // how many instances can be distributed
  edition: 1,               // integer >= 1; increment per seed
  owner: "alice",           // optional; defaults to signer
  brief: "Short description", // optional
  immutableData: { rarity: "common", base_power: 50 }, // validated against schema
})
```

### buildBulkDistribute
```typescript
buildBulkDistribute({
  signer: "alice",          // seed owner
  to: "bob",                // recipient of all instances (optional; defaults to signer)
  items: [
    { seedId: "seed_…", quantity: 3, seedTxId: "tx_…" },
  ],
  mutableData: { level: 1, xp: 0 }, // optional initial mutable fields
  imageOverrides: { "seed_…": { imageUrl: "https://…" } }, // optional
})
```

### buildList
```typescript
// async (computes imageHash, listingId, listingNonce)
await buildList({
  owner: "alice",
  nftId: "nft_…",
  price: { amount: "25.000", currency: "HIVE" },  // amount is a 3-decimal string
  expiresAt: Date.now() + 7 * 24 * 3600 * 1000,   // optional ms timestamp
  marketplace: "my-marketplace",  // optional scope tag for UI filtering
  imageUrl: "https://…",          // optional; SDK hashes it
})
// result.generatedIds = { listingId, listingNonce }
```

### buildBuy
```typescript
// sync (no async)
buildBuy({
  buyer: "bob",
  seller: "alice",
  nftId: "nft_…",
  listingId: "list_…",   // from client.getPaymentInfo()
  listTxId: "tx_…",
  txId: "tx_…",          // NFT creation tx
  nodeAccount: "nftlox",
  paymentSplit: {
    sellerAmount: 24.5,   royaltyAmount: 0.25, royaltyRecipient: "artist",
    feeAmount: 0.25,      feeAccount: "nftlox", totalPrice: 25.0, currency: "HIVE",
  },
})
// operations = [...transfers, custom_json]
```

### buildSetData / buildSetDataFrom
```typescript
// owner updates own NFT
buildSetData({
  owner: "alice",
  nftId: "nft_…",
  instanceDna: nft.instance_dna!, // required — binds to current state
  mutableData: { xp: 5000, level: 12 },
})

// operator updates on behalf of owner
buildSetDataFrom({
  operator: "ragnarok-server",
  nftId: "nft_…",
  instanceDna: nft.instance_dna!,
  mutableData: { xp: 5000, level: 12 },
})
```

### buildCollectionWithSeeds (orchestrator)
```typescript
const plan = await buildCollectionWithSeeds({
  creator: "alice",
  name: "Heroes",
  symbol: "HERO",
  totalPotential: 1000,   // max seeds (0 = unlimited)
  metadata: { description: "…", image: "https://…" },
  rules: { transferable: true, burnable: true, royaltyPct: 5 },
  schema: createSchemaBuilder()
    .immutable("rarity", "string")
    .mutable("xp", "uint32")
    .build(),
  seeds: [{ artId: "warrior", name: "Warrior", imageUrl: "…", maxSupply: 1000 }],
  owner: "alice",         // optional; where seeds land (defaults to creator)
}, {
  indexerBaseUrl: "https://api-nftlox.hivecreators.co",
  requireMultisigReady: true,  // fail if node multisig not ready
  feeCurrency: "HBD",
  feeAmount: "0.100",
})

// plan.success = true
// plan.collectionId
// plan.collectionStep.operations  → sign with active + node multisig
// plan.seedBatches[i].operations  → sign each with posting key
// plan.generatedIds["warrior"]    → precomputed seedId
```

---

## Schema types

24 types accepted in `immutable`/`mutable` fields:

```
string   bool   float   double
uint8    uint16   uint32   uint64
int8     int16    int32    int64
string[] bool[]   float[]  double[]
uint8[]  uint16[] uint32[] uint64[]
int8[]   int16[]  int32[]  int64[]
```

Field name rules: `/^[a-z][a-z0-9_]*$/`, max 64 chars, unique across immutable+mutable, max 64 total fields per collection.

Schema builder:
```typescript
import { createSchemaBuilder } from "nftlox-sdk";
const schema = createSchemaBuilder()
  .immutable("rarity", "string")
  .immutable("base_power", "uint16")
  .mutable("xp", "uint32")
  .build();
```

Pre-built templates: `GAMING_SCHEMA`, `ART_SCHEMA`, `COLLECTIBLE_SCHEMA`, `MUSIC_SCHEMA`.

---

## Indexer client

```typescript
import { createIndexerClient } from "nftlox-sdk";
const client = createIndexerClient("https://api-nftlox.hivecreators.co");
```

All methods are typed wrappers around unauthenticated GET endpoints:

```typescript
// Protocol
client.getStatus()                                      // SyncStatus
client.getHealth()                                      // HealthStatus
client.getStats()                                       // ProtocolStats

// Collections
client.getCollections({ creator?, limit?, offset? })
client.getCollection(collectionId)
client.getCollectionNfts(collectionId, { type?, limit?, offset? })
client.getCollectionStats(collectionId)
client.getCollectionSchemaHistory(collectionId)

// NFTs
client.getNft(nftId)
client.getNftOwner(nftId)                               // { owner: string }
client.getNftProof(nftId)                               // SPV ownership proof
client.getNftLoan(nftId)                                // { active, loan }
client.getCollectionInstances(collectionId, seedId, { limit?, offset? })

// Users
client.getUserNfts(username, { status?, type?, limit?, offset? })
client.getUserNftCount(username, params?)
client.getUserLoans(username, { role?: "lender" | "borrower" | "all" })
client.getUserCollections(username, params?)
client.getUserAssets(username, params?)

// Marketplace
client.getListings({ sort?, currency?, limit?, offset? })
client.getSales({ nftId?, collectionId?, seller?, buyer?, limit?, offset? })
client.getSalesVolume({ collectionId? })

// Transactions
client.getOperationStatus(txId)
// → { indexed, totalOperations, confirmed, invalid, orphaned, operations[] }

// Multisig (buy)
client.getPaymentInfo(nftId)   // always use this; never compute split yourself
client.multisig(request, options?)

// Helpers
client.getMultisigNodeAccount()
```

`getUserNfts` status filter: `"active" | "listed" | "lent"`.
`getUserNfts` type filter: `"seed" | "instance"`.

---

## Multisig helpers (standalone)

```typescript
import {
  requestBuyMultisig,
  requestCreateCollectionMultisig,
  fetchMultisigNodeAccount,
  resolveNodeAccountFromStatus,
} from "nftlox-sdk";

// For buy (alternative to client.multisig):
const resp = await requestBuyMultisig(indexerBaseUrl, { buyer, nftId, listingId, listTxId, transaction });

// For create_collection:
const sig = await requestCreateCollectionMultisig(indexerBaseUrl, { transaction });

// Get node account without a full client:
const nodeAccount = await fetchMultisigNodeAccount(indexerBaseUrl);
```

---

## Deterministic ID helpers

```typescript
import {
  generateDeterministicCollectionId,  // (creator, name, symbol)
  generateDeterministicSeedId,         // (collectionId, artId)
  generateDeterministicInstanceId,     // (seedId, instanceNumber)
  generateListingId,                   // (params) — used internally by buildList
} from "nftlox-sdk";

// All are async (SHA-256 via crypto.subtle)
const colId  = await generateDeterministicCollectionId("alice", "Heroes", "HERO");
const seedId = await generateDeterministicSeedId(colId, "warrior");
const nftId  = await generateDeterministicInstanceId(seedId, 1);
```

ID prefixes: `col_`, `seed_`, `nft_`, `list_`.

---

## SPV verifiers

```typescript
import {
  verifyNftOwnership,
  verifyListingPrice,
  verifyOperationOnChain,
  verifyDeterministicDerivation,
  resolveOperationById,
  createDefaultL1Config,
} from "nftlox-sdk";

const l1Config = createDefaultL1Config(); // { endpoints, timeoutMs }

// Verify the indexer's owner claim against Hive L1:
const r = await verifyNftOwnership({
  nftId: "nft_…",
  expectedOwner: "alice",
  indexerBaseUrl: "https://api-nftlox.hivecreators.co",
  l1Config,
});
// r.status = "verified" | "mismatch" | "error" | "not_found"

// Verify listing price on chain (before buying):
const lp = await verifyListingPrice({ listTxId, expectedPrice, expectedSeller, expectedNftId, l1Config });

// Verify any NFTLox op by tx_id + blockNum:
const op = await verifyOperationOnChain({ txId, blockNum, expectedAction, expectedSigner, l1Config });

// Pure — no network — recompute instance IDs:
const d = await verifyDeterministicDerivation({ seedId, instanceNumber, txId, blockNum, signer });
// d = { instanceId, instanceDna, accessKey }
```

---

## Error classes

```typescript
import { NftloxError, IndexerError, MultisigError } from "nftlox-sdk";

// All errors extend NftloxError (has .url, .name)
// IndexerError: .statusCode, .responseBody, .url
// MultisigError: .code (MultisigErrorCode), .retryAfterMs?, .url

try {
  await requestBuyMultisig(url, req);
} catch (err) {
  if (err instanceof MultisigError) { /* err.code */ }
  if (err instanceof IndexerError)  { /* err.statusCode */ }
}
```

Validation errors never throw — they live in `result.errors[]`.

---

## Multisig error codes

| Code | Cause |
|---|---|
| `MULTISIG_DISABLED` | Node has no active key configured |
| `RATE_LIMITED` | Too many requests from this IP |
| `NFT_LOCKED` | Another in-flight buy holds the DB lock |
| `NFT_NOT_FOUND` | nftId unknown to indexer |
| `NFT_NOT_LISTED` | Not currently for sale |
| `NFT_NOT_TRANSFERABLE` | Collection `transferable: false` |
| `NFT_EXPIRED_LISTING` | `expiresAt` in the past |
| `CANNOT_BUY_OWN` | buyer == seller |
| `SEED_HAS_INSTANCES` | Seeds with distributed instances can't be sold |
| `INVALID_PAYMENT_SPLIT` | Transfer amounts or memos don't match expected split |
| `INVALID_PROTOCOL_PAYLOAD` | listingId/listTxId mismatch or malformed custom_json |
| `NODE_ACCOUNT_MISMATCH` | Wrong node account in required_auths |
| `INVALID_TX_STRUCTURE` | Wrong op count, wrong order, expired window |
| `INTERNAL_ERROR` | Unexpected server error |

---

## Protocol constants

```typescript
import {
  PROTOCOL_ID,              // "nftlox_testnet"
  PROTOCOL_VERSION,         // "0.6.0"
  PROTOCOL_FEE_BPS,         // 100 (1%)
  MAX_ROYALTY_PCT,          // 50
  UNLIST_DELAY_BLOCKS,      // 3
  MAX_OPERATIONS_PER_TX,    // 5
  MAX_BULK_DISTRIBUTE_ITEMS, // 50
  MAX_BULK_DISTRIBUTE_TOTAL_QUANTITY, // 250
  SAFE_PAYLOAD_MAX_BYTES,   // 7372
  MEMO_PREFIX_BUY,          // "NFTLox BUY:"
  MEMO_PREFIX_ROYALTY,      // "NFTLox ROY:"
  MEMO_PREFIX_FEE,          // "NFTLox FEE:"
} from "nftlox-sdk";
```

---

## Key security rules

| Action | Key needed | Co-signer |
|---|---|---|
| `create_collection` | Active | Node (via `/api/multisig/collection`) |
| `buy` | Active | Node (via `/api/multisig`) |
| All other 18 actions | Posting | None |

- Game servers need posting key only — store it in an env var.
- Active key goes to a secure vault. Never in the server runtime unless doing a buy.
- Operator accounts (`data_operator_approve`) use posting key only.

---

## NFT state model

An NFT instance can be in one of these states:

| Status | Transfer? | List? | Lend? | Approve? | SetData? |
|---|---|---|---|---|---|
| `active` | Yes | Yes | Yes | Yes | Yes |
| `listed` | No | No (already listed) | No | No | Yes |
| `lent` | No | No | No | New: No / Existing: No | Yes |
| `burned` | — | — | — | — | — |

Lending: only the **borrower** can call `buildNftReturn`. Ownership never changes while lent — `getNftOwner` always returns the lender.

Seeds with `distributed > 0` cannot be transferred, listed, lent, or approved.

---

## Payment split formula

```
feeAmount     = round3(totalPrice × 0.01)          // PROTOCOL_FEE_BPS = 100
royaltyAmount = round3(totalPrice × royaltyPct/100)
sellerAmount  = totalPrice − feeAmount − royaltyAmount
```

Always read from `client.getPaymentInfo(nftId)` — never recompute. Any mismatch is rejected by the node with `INVALID_PAYMENT_SPLIT`.

---

## Confirmation polling

```typescript
async function waitForConfirmation(client, txId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.getOperationStatus(txId);
    if (s.indexed && s.confirmed === s.totalOperations) return s;
    if (s.invalid > 0) throw new Error(`Invalid op: ${JSON.stringify(s.operations)}`);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for ${txId}`);
}
```

---

## Common pitfalls

| Mistake | Correct pattern |
|---|---|
| Computing `paymentSplit` yourself | Always call `client.getPaymentInfo(nftId)` |
| Using `creator:` in `buildBulkDistribute` | Use `signer:` (the seed owner) |
| Missing `instanceDna` in `buildSetData` | Read it from `client.getNft(nftId).instance_dna` |
| Sending seed_id with instances=0 to marketplace | Seeds with `distributed > 0` cannot be sold |
| Assuming listing stays valid until `expiresAt` | Another buyer might buy it; always re-check before signing |
| Signing with active key for `set_data` | Posting key is enough for all data mutations |
| Lender calling `buildNftReturn` | Only the **borrower** can return a lent NFT |

---

## Indexer HTTP surface (real endpoints only)

```
GET  /api/status
GET  /api/health
GET  /api/stats
GET  /api/operation-status/:txId
GET  /api/payment-info/:nftId
GET  /api/collections
GET  /api/collections/:id
GET  /api/collections/:id/nfts
GET  /api/collections/:id/stats
GET  /api/collections/:id/schema-history
GET  /api/nfts/:id
GET  /api/nfts/:id/owner
GET  /api/nfts/:id/ownership
GET  /api/nfts/:id/proof
GET  /api/nfts/:id/loan
GET  /api/nfts/:id/instances
GET  /api/users/:username/assets
GET  /api/users/:username/nfts
GET  /api/users/:username/nfts/count
GET  /api/users/:username/loans
GET  /api/users/:username/collections
GET  /api/marketplace/listings
GET  /api/marketplace/sales
GET  /api/marketplace/volume
POST /api/multisig          (buy co-signing)
POST /api/multisig/collection  (create_collection co-signing)
```

There is **no** `/api/build/*` route. The indexer does not build transactions.

---

## Links to detailed docs

- [Getting Started](getting-started.md) — first transaction in 5 minutes
- [SDK Overview](sdk/overview.md) — mental model and flow patterns
- [SDK Reference](sdk/reference.md) — full builder type signatures
- [Signing & Broadcasting](broadcasting.md) — hive-tx / dhive / wax / Keychain examples
- [Data Formats](data-formats.md) — on-chain payload shapes for all 20 actions
- [Marketplace](guides/marketplace.md) — listing lifecycle + buy flow
- [Allowances & Operators](guides/allowances.md) — approve, approve-all, data operators
- [NFT Lending](guides/lending.md) — non-custodial rentals
- [SPV Verification](guides/spv.md) — L1-anchored client-side ownership checks
- [Seed Ceremony](use-cases/seed-ceremony.md) — launch script end-to-end
- [Game Development](use-cases/games.md) — full TCG flow
- [API Endpoints Reference](reference/api.md) — indexer HTTP surface
- [Error Codes Reference](reference/errors.md) — all error codes explained

# SPV Verification

NFTLox ships a client-side verification layer so a wallet, game client, or marketplace UI can re-derive NFT ownership edges from Hive L1 operation anchors (via public Hive RPC + HafAH). The current verifier checks the operation the indexer points at; for full trust minimization, compare the same NFT across independent indexers or state-root snapshots before accepting the current pointer.

Source: `packages/sdk/src/spv/`.

## What you can verify

| Verifier | Proves |
|---|---|
| `verifyNftOwnership` | The indexer's current-owner claim matches the referenced on-chain ownership operation. |
| `verifyListingPrice` | An active listing's seller/amount/currency/nftId match the `list` tx on Hive L1. |
| `verifyOperationOnChain` | A given tx_id + block contains an NFTLox `custom_json` with the expected `action` and `signer`. |
| `verifyDeterministicDerivation` | Recomputes `instanceId` / `nftDna` / `accessKey` from their domain-separated inputs. Pure; no network. |
| `resolveOperationById` | Looks up a specific operation by `operationId` (for UI deep-links from indexer rows to L1 proofs). |
| `resolveMutableData` | Resolves an operation whose `custom_json` committed a content-hash, checks the hash matches. |

## Configuration

```typescript
import { createDefaultL1Config } from "nftlox-sdk";

const l1Config = createDefaultL1Config();
// { endpoints: [...], timeoutMs: 8000 }

// Override for your environment:
l1Config.endpoints = ["https://api.hive.blog"];
l1Config.timeoutMs = 5000;
```

Default endpoints (round-robin on failure):

```
https://api.hive.blog
https://api.syncad.com
https://rpc.mahdiyari.info
https://anyx.io
```

Use your own Hive RPC if you depend on a specific node for rate limits or latency.

## Verify ownership

The canonical "does the indexer's current owner pointer resolve to Alice on L1?" check.

```typescript
import { createDefaultL1Config, verifyNftOwnership } from "nftlox-sdk";

const result = await verifyNftOwnership({
	nftId: "nft_abc…_7",
	expectedOwner: "alice",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config: createDefaultL1Config(),
});

if (result.status !== "verified") {
	// result.status = "mismatch" | "error" | "not_found"
	throw new Error(`${result.status}: ${result.message}`);
}
```

**What runs under the hood:**

1. `GET /api/nfts/{nftId}/proof` — indexer returns the ownership edge plus creation and collection anchors.
2. The SDK resolves `owner_operation_id` on HafAH and parses the ownership `custom_json`.
3. For `buy`, the SDK also resolves the listing transaction, the collection `create_collection` transaction, the payment transfers, and the prior `buy_commitment`.
4. The derived owner from L1 is compared to both `reportedOwner` (indexer) and `expectedOwner` (your call).
5. `status = "verified"` only if L1 ownership, collection rules, listing fields, payment split, and commitment all match the protocol contract.

**Result shape:**

```typescript
interface OwnershipVerificationResult {
	status: "verified" | "mismatch" | "error" | "not_found";
	nftId: string;
	reportedOwner: string;          // what the indexer claimed
	expectedOwner: string;          // what you claimed
	proofsChecked: number;
	checks: OwnershipCheckResult[]; // per-event breakdown
	verifiedAt: number;             // epoch ms
	durationMs: number;
	message: string;
}

interface OwnershipCheckResult {
	txId: string;
	blockNum: number;
	eventType: string;              // "mint", "transfer", "buy", "return", …
	expectedSigner: string;
	l1Status: "verified" | "mismatch" | "error" | "not_found";
	message: string;
	operationId?: string;
	previousOwner?: string | null;
	derivedOwner?: string | null;
}
```

Render `checks` in a UI if you want to show the full chain of custody.

## Verify listing price

Prevents a hostile indexer from claiming a discounted price.

```typescript
import { verifyListingPrice, createDefaultL1Config } from "nftlox-sdk";

const result = await verifyListingPrice({
	listTxId: "abc…1234",                          // from client.getPaymentInfo().listTxId
	expectedPrice: { amount: 25, currency: "HIVE" },
	expectedSeller: "alice",
	expectedNftId: "nft_abc…_7",
	l1Config: createDefaultL1Config(),
});
// result = { status, listTxId, blockNum, onChainPrice, onChainSeller, onChainNftId, message }
```

If `status === "verified"`, the listing on chain matches the four expected fields byte-for-byte. A mismatch means either the indexer lied, the listing was replaced, or the UI read a stale cache.

## Verify an arbitrary NFTLox operation

```typescript
import { verifyOperationOnChain, createDefaultL1Config } from "nftlox-sdk";

const result = await verifyOperationOnChain({
	txId: "abc…1234",
	blockNum: 92_345_678,
	expectedAction: "transfer",                  // ProtocolAction from @nftlox/protocol
	expectedSigner: "alice",
	l1Config: createDefaultL1Config(),
});
// result.status, result.actionMatch, result.signerMatch, result.rawPayload
```

Use this anywhere you surface a tx_id from an indexer response and want a one-click "verify on chain" button.

## Deterministic derivation (offline)

Pure math — no RPC calls. Useful for unit tests and to prove the SDK's ID generator matches the protocol's on-chain expectation.

```typescript
import { verifyDeterministicDerivation } from "nftlox-sdk";

const derived = await verifyDeterministicDerivation({
	seedId: "seed_…",
	instanceNumber: 42,
	txId: "abc…1234",
	blockNum: 92_345_678,
	signer: "alice",
});
// { instanceId, nftDna, accessKey }
```

These three IDs are the same ones the indexer writes to its tables when it processes the original `bulk_distribute`. Computing them locally lets a client anchor a deep-link (e.g. `/nft/{instanceId}`) before the indexer has even returned.

## Resolving operations by ID

Indexer rows reference operations by `operation_id` (the HafAH global op id). To jump from a row to a verified L1 proof:

```typescript
import { resolveOperationById, createDefaultL1Config } from "nftlox-sdk";

const op = await resolveOperationById({
	l1Config: createDefaultL1Config(),
	operationId: "12345678900000001",
	expectedActions: ["buy", "transfer"],         // optional allow-list
});
// op = { operationId, txId, blockNum, timestamp, protocolId, version, action, signer, data }
```

For mutable-data commitments (large off-chain blobs with an on-chain content hash), `resolveMutableData` performs the same lookup and checks the committed hash.

## When SPV is worth the round-trip

SPV isn't free — each verifier costs 1–3 RPC calls. Use it where the decision is high-value:

- A marketplace UI rendering a sale above a threshold ("verify before buying").
- A wallet showing a new incoming NFT ("verify sender is who the indexer says").
- A game client admitting an NFT into a competitive mode ("verify ownership + mint provenance").
- Any flow where the next step would be irreversible (HIVE transfer, on-chain sign).

For cheap reads (gallery listings, search results), trust the indexer and verify lazily on interaction.

## See also

- [SDK Reference — SPV verifiers](../sdk/reference.md#spv-verifiers)
- [Data Formats — deterministic ID derivation](../data-formats.md#deterministic-id-derivation)
- [Network State & Determinism](../concepts/protocol-invariants.md#network-state--determinism) — why client-side verification is the long-term trust anchor.

# SPV Verification

Client-side verification of NFTLox operations against Hive L1. The browser can verify ownership, deterministic derivation, listing prices, and generic on-chain operations without trusting an indexer response.

**Source implementation:** `packages/sdk/src/spv/`.

---

## What SPV Verifies

### NFT Ownership

1. The indexer returns a compact current-owner claim from `/api/nfts/{nftId}/proof`.
2. The claim is anchored by `owner_operation_id`.
3. The SDK resolves that operation through HAFAH/Hive L1.
4. The SDK derives the owner and previous owner from the L1 operation.
5. The result is verified only if L1, the indexer claim, and the expected owner agree.

### Deterministic Derivation

1. `instanceId` = `SHA-256(seedId, instanceNumber)`.
2. `instanceDna` = `SHA-256(seedId, instanceNumber, txId, blockNum)`.
3. `accessKey` = `SHA-256(instanceDna, signer, txId)`.

### Listing Prices

The SDK can fetch a list transaction from Hive L1 and compare the on-chain seller, NFT ID, amount, and currency against the price shown by a node or marketplace.

### Generic On-Chain Operations

The SDK can fetch a transaction and verify that it contains an NFTLox `custom_json` with the expected action and signer.

---

## Verify NFT Ownership

```typescript
import {
	createDefaultL1Config,
	verifyNftOwnership,
	type OwnershipVerificationResult,
} from "nftlox-sdk";

const result: OwnershipVerificationResult = await verifyNftOwnership({
	nftId: "nft_abc123",
	expectedOwner: "player-alice",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config: createDefaultL1Config(),
});

if (result.status !== "verified") {
	throw new Error(result.message);
}
```

### OwnershipVerificationResult Shape

```typescript
interface OwnershipVerificationResult {
	status: "verified" | "mismatch" | "error" | "not_found";
	nftId: string;
	reportedOwner: string;
	expectedOwner: string;
	proofsChecked: number;
	checks: OwnershipCheckResult[];
	verifiedAt: number;
	durationMs: number;
	message: string;
}
```

---

## Verify Deterministic Derivation

```typescript
import { verifyDeterministicDerivation } from "nftlox-sdk";

const derived = await verifyDeterministicDerivation({
	seedId: "seed_abc123",
	instanceNumber: 42,
	txId: "abc123def456789012345678901234567890abcd",
	blockNum: 92345678,
	signer: "player-alice",
});

console.log(derived.instanceId);
console.log(derived.instanceDna);
console.log(derived.accessKey);
```

---

## Verify Listing Price

```typescript
import { createDefaultL1Config, verifyListingPrice } from "nftlox-sdk";

const result = await verifyListingPrice({
	listTxId: "abc123def456789012345678901234567890abcd",
	expectedPrice: { amount: 10, currency: "HIVE" },
	expectedSeller: "alice",
	expectedNftId: "nft_abc123",
	l1Config: createDefaultL1Config(),
});

if (result.status !== "verified") {
	throw new Error(result.message);
}
```

---

## Verify Operation On-Chain

```typescript
import {
	createDefaultL1Config,
	verifyOperationOnChain,
} from "nftlox-sdk";

const result = await verifyOperationOnChain({
	txId: "abc123def456789012345678901234567890abcd",
	blockNum: 92345678,
	expectedAction: "transfer",
	expectedSigner: "player-alice",
	l1Config: createDefaultL1Config(),
});

console.log(result.status);
console.log(result.message);
```

---

## Configuration

```typescript
import { createDefaultL1Config } from "nftlox-sdk";

const l1Config = createDefaultL1Config();
l1Config.endpoints = ["https://api.hive.blog"];
l1Config.timeoutMs = 8000;
```

Default endpoints:

```
https://api.hive.blog
https://api.syncad.com
https://rpc.mahdiyari.info
https://anyx.io
```

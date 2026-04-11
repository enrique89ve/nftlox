# SPV Verification ("Boleto Suizo")

Client-side verification of NFTLox operations against Hive L1. Zero trust required -- any user can independently verify that pack openings, NFT ownership, and deterministic derivations match on-chain data.

**Source implementation:** `packages/sdk/src/spv/` -- browser and Node.js compatible, zero dependencies beyond `fetch`.

---

## Table of Contents

1. [Overview](#overview)
2. [What SPV Verifies](#what-spv-verifies)
3. [Running an Audit](#running-an-audit)
4. [Single Verification](#single-verification)
5. [Verify NFT Ownership](#verify-nft-ownership)
6. [Verify Deterministic Derivation](#verify-deterministic-derivation)
7. [Replay Drop Table Resolution](#replay-drop-table-resolution)
8. [Verify Operation On-Chain](#verify-operation-on-chain)
9. [Configuration](#configuration)
10. [Integration Examples](#integration-examples)

---

## Overview

The name "Boleto Suizo" (Swiss Ticket) reflects the verification philosophy: instead of checking every single transaction, randomly sample a subset and verify those against Hive L1. If any sample fails, the indexer is provably dishonest.

The SPV module uses the HAFAH REST API to fetch raw transactions directly from Hive, then replays the same deterministic functions (RNG, SHA-256 derivation) that the indexer used. If the locally computed results match the indexer's reported results, the operation is verified.

**Trust model:**

| Component | Trusted? | Why |
|-----------|----------|-----|
| Hive L1 blockchain | Yes | Immutable public ledger |
| HAFAH REST API | Partially | Returns raw tx data; multiple endpoints for redundancy |
| NFTLox indexer | No | Everything it reports is verified against L1 |
| SDK deterministic functions | Yes | Open source, reproducible (see [RNG Reference](rng-reference.md)) |

---

## What SPV Verifies

### Pack Openings

1. The `pack_open` transaction exists on Hive L1 with the correct signer
2. The RNG seed (`txId:blockNum:signer:packId:packIndex`) matches the on-chain data
3. The drop table resolution produces the same `seedId` selections
4. Each minted NFT's `instanceId` matches the deterministic derivation

### NFT Ownership

1. The indexer returns a compact current-owner claim from `/api/nfts/{nftId}/proof`
2. The claim is anchored by `owner_operation_id`, not by a mutable local tx field
3. The SDK resolves `owner_operation_id` through HAFAH/Hive L1 and parses the on-chain `custom_json`
4. The SDK derives the owner and previous owner from the L1 operation, then compares them with the indexer claim and the expected owner
5. `owner_block_num` is kept as block context, not as unique proof, because one block can contain multiple ownership operations

### Deterministic Derivation

1. `instanceId` = `SHA-256(seedId, instanceNumber)`
2. `instanceDna` = `SHA-256(seedId, instanceNumber, txId, blockNum)`
3. `accessKey` = `SHA-256(instanceDna, signer, txId)`

### On-Chain Operations

Generic verification that any NFTLox `custom_json` operation exists on Hive with the expected action and signer.

---

## Running an Audit

`runAudit` performs a full "Boleto Suizo" audit: fetches recent `pack_open` events from the indexer, randomly samples a subset, and verifies each one against Hive L1.

```typescript
import {
	createAuditorConfig,
	runAudit,
	type AuditReport,
} from "@nftlox/sdk/spv";

const config = createAuditorConfig({
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	sampleSize: 3,
});

const report: AuditReport = await runAudit(config);

console.log(`Checked: ${report.samplesChecked}`);
console.log(`Verified: ${report.verified}`);
console.log(`Mismatches: ${report.mismatches}`);
console.log(`Errors: ${report.errors}`);
console.log(`Duration: ${report.durationMs}ms`);

// Inspect individual results
for (const result of report.results) {
	if (result.status === "mismatch") {
		console.error(`MISMATCH in tx ${result.txId}:`);
		for (const m of result.mismatches) {
			console.error(`  ${m.field}: expected ${m.expected}, got ${m.actual}`);
		}
	}
}
```

### Audit Flow

1. Fetches recent packs from `GET /api/packs?limit=20`
2. For each pack, fetches history from `GET /api/packs/{packId}/history?limit=50`
3. Collects all `pack_open` events
4. Randomly samples `sampleSize` events (Fisher-Yates partial shuffle)
5. For each sample, runs `verifyPackOpen` (full L1 verification)

### AuditReport Shape

```typescript
interface AuditReport {
	startedAt: number;       // Unix timestamp (ms)
	completedAt: number;
	durationMs: number;
	samplesChecked: number;
	verified: number;        // status === "verified"
	mismatches: number;      // status === "mismatch"
	errors: number;          // status === "error" | "not_found"
	results: PackOpenVerificationResult[];
}
```

---

## Single Verification

Verify a specific `pack_open` transaction by its `txId` and `blockNum`.

```typescript
import {
	createAuditorConfig,
	runSingleVerification,
} from "@nftlox/sdk/spv";

const config = createAuditorConfig({
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
});

const result = await runSingleVerification(
	config,
	"abc123def456789012345678901234567890abcd", // txId
	92345678,                                    // blockNum
);

if (result.status === "verified") {
	console.log(`Verified ${result.reportedMintedNfts.length} NFTs`);
} else if (result.status === "mismatch") {
	console.error(`Found ${result.mismatches.length} mismatch(es)`);
}
```

### PackOpenVerificationResult Shape

```typescript
interface PackOpenVerificationResult {
	status: "verified" | "mismatch" | "error" | "not_found";
	txId: string;
	blockNum: number;
	signer: string;
	packId: string;
	expectedSeedIds: string[];          // RNG replay output
	reportedMintedNfts: ReportedMintedNft[];
	mismatches: SpvMismatch[];
	verifiedAt: number;
	durationMs: number;
	message: string;
}
```

### What `verifyPackOpen` Does Internally

1. Fetches the transaction from Hive L1 via HAFAH REST API
2. Parses the `custom_json` operation and validates it is a `pack_open`
3. Fetches pack info (`drop_table`, `items_per_pack`) from the indexer
4. Fetches pack history to find the reported minted NFTs
5. Replays the RNG for each `packIndex` and compares `seedId` selections
6. Verifies deterministic derivation (`instanceId`) for each reported NFT

---

## Verify NFT Ownership

Verifies the current ownership edge for an NFT. The indexer provides the snapshot, but the SDK treats it as untrusted: it resolves `owner_operation_id` directly through HAFAH/Hive L1, derives the owner from the on-chain NFTLox operation, and only verifies if the L1-derived owner matches both the indexer claim and `expectedOwner`.

This is current-edge verification, not a full historical replay. The database can be rebuilt from Hive, and a corrupted local owner value should be rejected because the referenced L1 operation will not derive the same owner.

```typescript
import {
	verifyNftOwnership,
	createDefaultL1Config,
	type OwnershipVerificationResult,
} from "@nftlox/sdk/spv";

const l1Config = createDefaultL1Config();

const result: OwnershipVerificationResult = await verifyNftOwnership({
	nftId: "abc123-instance-001",
	expectedOwner: "player-alice",
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	l1Config,
});

console.log(`Status: ${result.status}`);
console.log(`Reported owner: ${result.reportedOwner}`);
console.log(`Proofs checked: ${result.proofsChecked}`);

for (const check of result.checks) {
	console.log(`  ${check.eventType} op=${check.operationId} -> ${check.l1Status}`);
	console.log(`  L1 owner: ${check.derivedOwner}`);
}
```

### Ownership Verification Flow

1. Fetches the ownership proof from `GET /api/nfts/{nftId}/proof` (same proof contract as `/api/nfts/{nftId}/ownership`)
2. Receives `owner`, `previous_owner`, `owner_action`, `owner_operation_id`, `owner_block_num`, creation anchors, and `claim_hash`
3. Resolves `owner_operation_id` from Hive L1 through HAFAH
4. Derives the real owner and previous owner from the on-chain NFTLox action (`mint`, `bulk_distribute`, `transfer`, `nft_transfer_from`, or `buy`)
5. Returns `"verified"` only if the L1-derived owner matches `expectedOwner`, the indexer-reported owner, and the indexer-reported previous owner

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

interface OwnershipCheckResult {
	txId: string;
	blockNum: number;
	eventType: string;
	expectedSigner: string;
	l1Status: "verified" | "mismatch" | "error" | "not_found";
	message: string;
	operationId?: string;
	previousOwner?: string | null;
	derivedOwner?: string | null;
}
```

---

## Verify Deterministic Derivation

Pure function (no network calls). Recomputes `instanceId`, `instanceDna`, and `accessKey` from the same inputs the indexer used. Async due to SHA-256.

```typescript
import { verifyDeterministicDerivation } from "@nftlox/sdk/spv";

const derived = await verifyDeterministicDerivation({
	seedId: "my-collection:sword-001",
	instanceNumber: 42,
	txId: "abc123def456789012345678901234567890abcd",
	blockNum: 92345678,
	signer: "player-alice",
});

console.log(`instanceId: ${derived.instanceId}`);
console.log(`instanceDna: ${derived.instanceDna}`);
console.log(`accessKey: ${derived.accessKey}`);

// Compare with what the indexer reported
if (derived.instanceId !== indexerReportedInstanceId) {
	throw new Error("instanceId derivation mismatch -- indexer may be dishonest");
}
```

### Input Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `seedId` | `string` | The seed's unique identifier |
| `instanceNumber` | `number` | The instance number (extracted from instanceId) |
| `txId` | `string` | Hive transaction ID of the mint/pack_open |
| `blockNum` | `number` | Block number where the tx was included |
| `signer` | `string` | Hive account that signed the operation |

### Output

```typescript
interface DeterministicDerivationResult {
	instanceId: string;   // SHA-256(seedId, instanceNumber)
	instanceDna: string;  // SHA-256(seedId, instanceNumber, txId, blockNum)
	accessKey: string;    // SHA-256(instanceDna, signer, txId)
}
```

---

## Replay Drop Table Resolution

Pure function (no network calls). Replays the exact RNG that determined which seeds were selected during a pack opening. Uses the same `buildRngSeed` and `resolveDropTable` functions as the indexer.

```typescript
import { replayDropTableResolution, buildRngSeed } from "@nftlox/sdk/spv";

const expectedSeeds = replayDropTableResolution({
	txId: "abc123def456789012345678901234567890abcd",
	blockNum: 92345678,
	signer: "player-alice",
	packId: "my-pack-001",
	packIndex: 0,
	dropTable: [
		{ seedId: "seed_common", weight: 100 },
		{ seedId: "seed_rare", weight: 20 },
		{ seedId: "seed_epic", weight: 5 },
		{ seedId: "seed_legend", weight: 1 },
	],
	itemsPerPack: 5,
});

console.log(`Selected seeds:`, expectedSeeds);
// e.g. ["seed_common", "seed_common", "seed_rare", "seed_common", "seed_common"]
```

### RNG Seed Format

The RNG seed is built from immutable on-chain data:

```
${txId}:${blockNum}:${signer}:${packId}:${packIndex}
```

You can also build it manually:

```typescript
import { buildRngSeed } from "@nftlox/sdk/spv";

const seed = buildRngSeed(
	"abc123def456789012345678901234567890abcd",
	92345678,
	"player-alice",
	"my-pack-001",
	0,
);
// "abc123def456789012345678901234567890abcd:92345678:player-alice:my-pack-001:0"
```

See [RNG Algorithm Reference](rng-reference.md) for the full algorithm specification and test vectors.

---

## Verify Operation On-Chain

Generic verifier for any NFTLox operation. Fetches a transaction from L1 and checks that the action and signer match.

```typescript
import {
	verifyOperationOnChain,
	createDefaultL1Config,
} from "@nftlox/sdk/spv";

const result = await verifyOperationOnChain({
	txId: "abc123def456789012345678901234567890abcd",
	blockNum: 92345678,
	expectedAction: "transfer",
	expectedSigner: "player-alice",
	l1Config: createDefaultL1Config(),
});

console.log(`Found on-chain: ${result.foundOnChain}`);
console.log(`Action match: ${result.actionMatch}`);
console.log(`Signer match: ${result.signerMatch}`);

if (result.rawPayload) {
	console.log(`Payload:`, result.rawPayload);
}
```

### OnChainVerificationResult Shape

```typescript
interface OnChainVerificationResult {
	status: "verified" | "mismatch" | "error" | "not_found";
	txId: string;
	blockNum: number;
	foundOnChain: boolean;
	actionMatch: boolean;
	signerMatch: boolean;
	rawPayload?: Record<string, unknown>;
	message: string;
}
```

---

## Configuration

### AuditorConfig

```typescript
import { createAuditorConfig } from "@nftlox/sdk/spv";

const config = createAuditorConfig({
	indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	hiveEndpoints: [
		"https://api.hive.blog",
		"https://api.syncad.com",
		"https://rpc.mahdiyari.info",
		"https://anyx.io",
	],
	hiveTimeoutMs: 4000,
	sampleSize: 3,
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `indexerBaseUrl` | `""` | NFTLox indexer API base URL |
| `hiveEndpoints` | 4 public nodes | HAFAH-compatible Hive API endpoints. Tried in order; first success wins. |
| `hiveTimeoutMs` | `4000` | Timeout per endpoint (ms). Higher than Wax default (2000ms) to account for HAFAH REST overhead. |
| `sampleSize` | `3` | Number of events to randomly sample per audit. |

### HiveL1Config

Low-level config for direct verifier calls:

```typescript
import { createDefaultL1Config } from "@nftlox/sdk/spv";

const l1Config = createDefaultL1Config();
// { endpoints: [...DEFAULT_HIVE_ENDPOINTS], timeoutMs: 4000 }

// Override for a specific use case
l1Config.endpoints = ["https://api.hive.blog"];
l1Config.timeoutMs = 8000;
```

### Default Hive Endpoints

The SDK ships with 4 public HAFAH-compatible endpoints:

```
https://api.hive.blog
https://api.syncad.com
https://rpc.mahdiyari.info
https://anyx.io
```

All endpoints are tried in order. If one fails (timeout, HTTP error, malformed response), the next is attempted. A `HiveRpcError` is thrown only if all endpoints fail.

---

## Integration Examples

### Browser (React / Svelte / Vanilla)

```typescript
import {
	createAuditorConfig,
	runAudit,
	runSingleVerification,
	verifyNftOwnership,
	createDefaultL1Config,
} from "@nftlox/sdk/spv";

// Full audit -- run on page load or on a timer
async function auditIndexer() {
	const config = createAuditorConfig({
		indexerBaseUrl: "https://api-nftlox.hivecreators.co",
		sampleSize: 3,
	});

	const report = await runAudit(config);

	if (report.mismatches > 0) {
		showWarning("Indexer integrity check failed -- some operations do not match Hive L1");
	} else {
		showBadge(`Verified: ${report.verified}/${report.samplesChecked} samples`);
	}
}

// Verify a specific pack opening the user just witnessed
async function verifyMyPackOpen(txId: string, blockNum: number) {
	const config = createAuditorConfig({
		indexerBaseUrl: "https://api-nftlox.hivecreators.co",
	});

	const result = await runSingleVerification(config, txId, blockNum);
	return result.status === "verified";
}

// Verify that I own an NFT before trading
async function verifyMyOwnership(nftId: string, myUsername: string) {
	const result = await verifyNftOwnership({
		nftId,
		expectedOwner: myUsername,
		indexerBaseUrl: "https://api-nftlox.hivecreators.co",
		l1Config: createDefaultL1Config(),
		sampleSize: 3,
	});

	return result.status === "verified";
}
```

### Node.js / Bun (Server-Side)

```typescript
import {
	createAuditorConfig,
	runAudit,
	verifyDeterministicDerivation,
	replayDropTableResolution,
} from "@nftlox/sdk/spv";

// Scheduled audit (e.g., cron job every 5 minutes)
async function scheduledAudit() {
	const config = createAuditorConfig({
		indexerBaseUrl: process.env.INDEXER_URL!,
		sampleSize: 5,
		hiveTimeoutMs: 8000,
	});

	const report = await runAudit(config);

	if (report.mismatches > 0) {
		await sendAlert({
			level: "critical",
			message: `SPV audit failed: ${report.mismatches} mismatch(es)`,
			details: report.results.filter((r) => r.status === "mismatch"),
		});
	}

	return report;
}

// Offline verification -- no network needed
async function verifyLocally() {
	// Replay the RNG
	const seeds = replayDropTableResolution({
		txId: "abc123def456789012345678901234567890abcd",
		blockNum: 92345678,
		signer: "player-alice",
		packId: "my-pack-001",
		packIndex: 0,
		dropTable: [
			{ seedId: "common", weight: 100 },
			{ seedId: "rare", weight: 20 },
		],
		itemsPerPack: 5,
	});

	// Verify derivation for each seed
	for (let i = 0; i < seeds.length; i++) {
		const derived = await verifyDeterministicDerivation({
			seedId: seeds[i]!,
			instanceNumber: i + 1,
			txId: "abc123def456789012345678901234567890abcd",
			blockNum: 92345678,
			signer: "player-alice",
		});
		console.log(`NFT ${i + 1}: instanceId=${derived.instanceId}`);
	}
}
```

### Error Handling

```typescript
import { HiveRpcError } from "@nftlox/sdk/spv";

try {
	const report = await runAudit(config);
} catch (err) {
	if (err instanceof HiveRpcError) {
		console.error(`All Hive endpoints failed: ${err.message}`);
		console.error(`Last endpoint tried: ${err.endpoint}`);
	} else {
		throw err;
	}
}
```

---

## Exported API Summary

| Function | Network? | Description |
|----------|----------|-------------|
| `runAudit(config)` | Yes | Full Boleto Suizo audit with random sampling |
| `runSingleVerification(config, txId, blockNum)` | Yes | Verify one specific pack_open transaction |
| `verifyPackOpen(params)` | Yes | Low-level pack_open verification |
| `verifyNftOwnership(params)` | Yes | Ownership + history sampling verification |
| `verifyOperationOnChain(params)` | Yes | Generic on-chain operation check |
| `verifyDeterministicDerivation(params)` | No | Recompute instanceId, DNA, accessKey locally |
| `replayDropTableResolution(params)` | No | Replay RNG seed selection locally |
| `buildRngSeed(txId, blockNum, signer, packId, packIndex)` | No | Build the RNG seed string |
| `createAuditorConfig(overrides?)` | No | Create audit configuration with defaults |
| `createDefaultL1Config()` | No | Create L1 client configuration |
| `fetchTransaction(config, txId)` | Yes | Fetch raw tx from Hive via HAFAH |
| `parseNftloxOperation(tx)` | No | Parse NFTLox custom_json from a HAFAH tx |

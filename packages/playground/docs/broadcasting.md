# Signing & Broadcasting

The SDK builds **unsigned** Hive operations. Signing and broadcasting are your responsibility — because your private keys must never leave your machine. This page documents the three flows you will actually encounter, with runnable code for `hive-tx`, `@hiveio/wax`, `@hiveio/dhive`, and Hive Keychain.

## The three flows

| Flow | Triggered by | Who signs what | Transport |
|---|---|---|---|
| **Single-signer, posting** | 17 of 20 builders (mint, transfer, list, unlist, set_data, approvals, lending…) | You, posting key | Any Hive RPC |
| **Single-signer, active + multisig** | `buildBuy` | You sign active; node co-signs via `/api/multisig` | POST to indexer, then Hive RPC |
| **Two-op, dual-signer** | `buildCollection` | You sign op[0] active; node signs op[1] via `/api/multisig/collection` | POST to indexer, then Hive RPC |

`result.keyType` always tells you which key to use. `result.coSigners` is present **only** for the dual-signer flow.

## Operation shape

Every builder returns Hive-native tuples:

```json
["custom_json", {
	"required_auths": [],
	"required_posting_auths": ["alice"],
	"id": "nftlox_testnet",
	"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.6.0\",\"action\":\"mint\",\"data\":{…}}"
}]
```

```json
["transfer", {
	"from": "alice",
	"to": "nftlox",
	"amount": "0.100 HBD",
	"memo": "NFTLox collection fee:col_…"
}]
```

Active-auth `custom_json`s list the signer under `required_auths`; posting-auth operations use `required_posting_auths`. You rarely need to inspect this — `result.keyType` is the source of truth.

## Limits to remember

| Limit | Value | Enforcement |
|---|---|---|
| Ops per Hive transaction | 5 (`MAX_OPERATIONS_PER_TX`) | Indexer rejects more. |
| `custom_json` byte size | ≤8192 (`HIVE_CUSTOM_JSON_MAX_BYTES`) | Hive consensus rejects larger. |
| Safe payload budget | 7372 B (`SAFE_PAYLOAD_MAX_BYTES`, 90%) | SDK sizing utilities respect this. |
| Delay between txs | 4000 ms (`TX_DELAY_MS`) | Allows block confirmation. |
| Multisig expiration | 125 s (`MULTISIG_EXPIRATION_MS`) | Response's `expiration` timestamp. |

## Hive RPC nodes

Any public node works. Rotate on failure.

| Node | URL |
|---|---|
| hive.blog | `https://api.hive.blog` |
| deathwing | `https://api.deathwing.me` |
| arcange | `https://hive-api.arcange.eu` |
| openhive | `https://api.openhive.network` |

---

## Flow 1 — Single-signer, posting auth

This covers nearly every mutation. Build, sign with posting key, broadcast.

### With `hive-tx`

```typescript
import { buildSeed } from "nftlox-sdk";
import hive from "hive-tx";

hive.config.set("node", "https://api.hive.blog");

const result = await buildSeed({
	collectionId: "col_abcdef0123456789abcd",
	signer: "alice",
	artId: "founders-card",
	name: "Founder's Card",
	imageUrl: "https://example.com/cards/founder.png",
	maxSupply: 100,
	edition: 1,
});

if (!result.success) {
	throw new Error(JSON.stringify(result.errors));
}

const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.sign(hive.PrivateKey.from(process.env.HIVE_POSTING_KEY!));
const broadcast = await tx.broadcast();

if (broadcast?.error) throw new Error(JSON.stringify(broadcast.error));
console.log("tx_id:", broadcast?.result?.tx_id);
```

### With `@hiveio/dhive`

```typescript
import { Client, PrivateKey } from "@hiveio/dhive";

const client = new Client(["https://api.hive.blog"]);
const key = PrivateKey.fromString(process.env.HIVE_POSTING_KEY!);
const { id } = await client.broadcast.sendOperations(result.operations as any, key);
```

### With `@hiveio/wax`

```typescript
import { createHiveChain } from "@hiveio/wax";

const chain = await createHiveChain();
const tx = await chain.getTransactionBuilder();
for (const op of result.operations) {
	tx.push(op as any);
}
const signed = tx.build(chain.getPublicKey(process.env.HIVE_POSTING_KEY!));
await chain.broadcast(signed);
```

### With Hive Keychain (browser)

```html
<script src="https://cdn.jsdelivr.net/npm/hive-keychain/dist/keychain.js"></script>
```

```typescript
declare const hive_keychain: any;

hive_keychain.requestBroadcast(
	result.signer,              // "alice"
	result.operations,          // already in tuple form
	result.keyType,             // "Posting"
	(response: any) => {
		if (!response.success) return console.error(response);
		console.log("tx_id:", response.result.tx_id);
	},
);
```

---

## Flow 2 — Buying (active + node multisig)

The `buy` transaction has two active authorities: the buyer signs the payment transfers, and the node signs the `custom_json`. `buildBuy` already assembles the operations in the correct order and marks the custom_json op in `coSigners`.

Canonical sequence:

1. `client.getPaymentInfo(nftId)` → exact split (seller + royalty + fee).
2. `buildBuy({ buyer, seller, nodeAccount, …paymentSplit })` → `[...transfers, custom_json]`.
3. Wrap in a Hive transaction **without signing**.
4. POST the raw transaction to `/api/multisig` (via `client.multisig` or `requestBuyMultisig`) — the SDK solves the PoW token automatically.
5. On `{ ok: true }`, append the returned `signature` to `tx.signatures`, add the buyer's own active signature, and broadcast.

```typescript
import {
	buildBuy,
	createIndexerClient,
	requestBuyMultisig,
	MultisigError,
} from "nftlox-sdk";
import hive from "hive-tx";

const INDEXER = "https://api-nftlox.hivecreators.co";
const RPC = "https://api.hive.blog";
hive.config.set("node", RPC);

const client = createIndexerClient(INDEXER);
const payment = await client.getPaymentInfo("nft_…");

const result = buildBuy({
	buyer: "alice",
	seller: payment.seller,
	nftId: payment.nftId,
	listingId: payment.listingId,
	listTxId: payment.listTxId,
	txId: payment.txId,
	nodeAccount: payment.nodeAccount,
	paymentSplit: {
		sellerAmount: payment.sellerAmount,
		royaltyAmount: payment.royaltyAmount,
		royaltyRecipient: payment.royaltyRecipient,
		feeAmount: payment.feeAmount,
		feeAccount: payment.feeAccount,
		totalPrice: payment.totalPrice,
		currency: payment.currency as "HIVE" | "HBD",
	},
});
if (!result.success) throw new Error(JSON.stringify(result.errors));

// 1. Create unsigned tx
const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);

// 2. Node co-signs
const resp = await requestBuyMultisig(INDEXER, {
	buyer: "alice",
	nftId: payment.nftId,
	listingId: payment.listingId,
	listTxId: payment.listTxId,
	transaction: tx.transaction,
});
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: INDEXER });

// 3. Attach node sig + buyer's active sig, broadcast
tx.transaction.signatures.push(resp.signature);
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));
const broadcast = await tx.broadcast();
```

### With Hive Keychain

Keychain has no native "external signature merge" API. The idiomatic pattern is: build, co-sign node-first, then call `requestSignedCall` or `requestBroadcast` with `keyType: "Active"` — Keychain adds the buyer's signature alongside the node's and broadcasts. When the dApp already holds the partially-signed transaction, use `requestSignTx` / `requestSignedTx` (version-dependent) to obtain the buyer's signature and post it to Hive yourself.

### Multisig error handling

```typescript
try {
	const resp = await requestBuyMultisig(INDEXER, request);
} catch (err) {
	if (err instanceof MultisigError) {
		switch (err.code) {
			case "NFT_LOCKED":        // another buy is in flight
			case "RATE_LIMITED":      // back off err.retryAfterMs
			case "INDEXER_LAGGED":    // node's DB is behind Hive head
			case "POW_REQUIRED":      // bump difficulty with { powBits: 20 }
				break;
		}
	}
}
```

The node will refuse to co-sign if:

- the listing is no longer `active` (unlisted, expired, or already sold),
- the payment split in the transaction does not match its own computation,
- the indexer is more than `MULTISIG_LAG_MAX_BLOCKS` (3 blocks, ~9s) behind Hive head,
- the transaction expiration is farther out than `MULTISIG_EXPIRATION_MS` (125 s).

## Flow 3 — Creating a collection (dual-signer)

`buildCollection` returns **two operations**: a `transfer` signed by the creator (active), and a `custom_json` whose `required_auths` is the node account. Both must be in the **same Hive transaction** — the indexer pairs the fee to the payload by `tx_id`.

```
operations[0] = ["transfer",    { from: "alice", to: "nftlox", amount: "0.100 HBD", memo: "NFTLox collection fee:col_…" }]
operations[1] = ["custom_json", { required_auths: ["nftlox"], ...create_collection payload }]
```

```typescript
import {
	buildCollection,
	createSchemaBuilder,
	requestCreateCollectionMultisig,
	MultisigError,
} from "nftlox-sdk";
import hive from "hive-tx";

const INDEXER = "https://api-nftlox.hivecreators.co";
hive.config.set("node", "https://api.hive.blog");

const result = await buildCollection({
	name: "Heroes",
	symbol: "HERO",
	creator: "alice",
	totalPotential: 1000,
	metadata: { description: "Hero cards", image: "https://…" },
	rules: { transferable: true, burnable: true, royaltyPct: 5 },
	schema: createSchemaBuilder()
		.immutable("rarity", "string")
		.mutable("xp", "uint32")
		.build(),
}, { indexerBaseUrl: INDEXER, requireMultisigReady: true });

if (!result.success) throw new Error(JSON.stringify(result.errors));

// Both ops MUST live in the same Hive transaction
const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);

// Node co-signs op[1]
const resp = await requestCreateCollectionMultisig(INDEXER, {
	transaction: tx.transaction,
});
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: INDEXER });

tx.transaction.signatures.push(resp.signature);

// Creator signs op[0] and the transaction as a whole
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));

const broadcast = await tx.broadcast();
console.log("collectionId:", result.generatedIds?.collectionId);
console.log("tx_id:", broadcast?.result?.tx_id);
```

## Confirming indexation

Broadcasting only confirms Hive consensus accepted the transaction. The NFTLox indexer needs 1–2 blocks (~3–6 s) to materialize the state change.

```typescript
const poll = async (txId: string) => {
	for (let attempt = 0; attempt < 10; attempt++) {
		const status = await client.getOperationStatus(txId);
		if (status.indexed) return status;
		await new Promise(r => setTimeout(r, 2000));
	}
	throw new Error("Timed out waiting for indexer");
};

const status = await poll(broadcast.result.tx_id);
console.log(`${status.confirmed}/${status.totalOperations} ops confirmed`);
for (const op of status.operations) {
	if (op.status !== "confirmed") {
		console.warn(`${op.action} → ${op.status}: ${op.reason}`);
	}
}
```

`indexed: false` means the tx has not yet been observed — retry. `invalid: N` means the indexer reached it but rejected it (schema mismatch, state conflict, invalid signer); `op.reason` explains why.

## Common rejection reasons

| Symptom | Cause |
|---|---|
| `broadcast.error` with `missing_authority` | Wrong key type for the action. Check `result.keyType`. |
| `broadcast.error` with `tx_missing_active_auth` on `buy` | You signed posting instead of active, or omitted the node signature. |
| Indexer returns `invalid` with `SCHEMA_MISMATCH` | `immutableData`/`mutableData` has extra keys or wrong types. Validate against `client.getCollection(id).schema`. |
| Indexer `invalid` with `NFT_NOT_FOUND` | Using a seed before it is indexed — poll `getOperationStatus` first. |
| Multisig returns `INVALID_PAYMENT_SPLIT` | You computed the split instead of using `getPaymentInfo`. |
| Multisig returns `INDEXER_LAGGED` | Indexer is >3 blocks behind Hive head. Retry or switch indexer. |

## See also

- [SDK Reference](sdk/reference.md) — full list of builders and return types.
- [Data Formats](data-formats.md) — on-chain payload shape for every action.
- [Error Codes](reference/errors.md) — every `ValidationError` code and multisig `MultisigErrorCode`.

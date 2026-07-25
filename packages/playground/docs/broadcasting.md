# Signing & Broadcasting

The SDK builds **unsigned** Hive operations. Signing and broadcasting are your responsibility — because your private keys must never leave your machine. This page documents the three flows you will actually encounter, with runnable code for `hive-tx`, `@hiveio/wax`, `@hiveio/dhive`, and Hive Keychain.

## The three flows

| Flow | Triggered by | Who signs what | Transport |
|---|---|---|---|
| **Single-signer, posting** | 17 of 20 builders (mint, transfer, list, unlist, set_data, approvals, lending…) | You, posting key | Any Hive RPC |
| **Node-last buy** | `buildBuy` | You sign the full tx (active); node validates, broadcasts a `buy_commitment`, co-signs, and broadcasts the settled tx itself | POST signed tx to `/api/multisig/buy` — you do **not** broadcast |
| **Two-op, dual-signer** | `buildCollection` | You sign op[0] active; node signs op[1] via `/api/multisig/collection` | POST to indexer, then Hive RPC |

`result.keyType` always tells you which key to use. `result.coSigners` is present **only** for the dual-signer flow.

## Operation shape

Every builder returns Hive-native tuples:

```json
["custom_json", {
	"required_auths": [],
	"required_posting_auths": ["alice"],
	"id": "nftlox_testnet",
	"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.10.0\",\"action\":\"mint\",\"data\":{…}}"
}]
```

```json
["transfer", {
	"from": "alice",
	"to": "nftlox",
	"amount": "0.100 HBD",
	"memo": "NFTLox FEE-COL:col_…"
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
| Buy tx expiration range | `MULTISIG_TX_MIN_EXPIRATION_MS` (90 s) – `MULTISIG_TX_MAX_EXPIRATION_MS` (120 s) | `/api/multisig/buy` rejects anything outside. The MIN budgets for irreversible-block observation plus a short signing/broadcast window; MAX equals the `buy_commitment` TTL. |
| Recommended buy tx expiration | `RECOMMENDED_BUY_TX_EXPIRATION_MS` (120 s) | SDK default — equals MAX. First-class SDK callers get the full finality-safe orchestration window. Lower it toward `MULTISIG_TX_MIN_EXPIRATION_MS` only when explicitly minimizing the orphan-risk window. |

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

## Flow 2 — Buying (node-last)

`buy` is a single Hive transaction with two required authorities: the buyer signs the transfers with their active key, and the node signs the trailing `custom_json` (`required_auths: [nodeAccount]`). What changed in 0.7.0 is **who drives the settlement**: the node goes last, not the buyer.

Canonical sequence:

1. `client.getPaymentInfo(nftId)` → exact split (seller + royalty + fee).
2. `buildBuy({ buyer, seller, nodeAccount, …paymentSplit })` → `[...transfers, custom_json]`.
3. Wrap in a Hive transaction and **sign it with the buyer's active key**.
4. POST the buyer-signed transaction to `/api/multisig/buy` (via `client.requestBuyMultisig` / `requestBuyMultisig`). The SDK solves the PoW token automatically.
5. The indexer validates, broadcasts a `buy_commitment` on Hive to reserve the NFT, waits for that commitment to win the cross-node ordering race, appends its own active signature, and broadcasts the settled buy transaction itself.
6. On `{ ok: true }`, the response carries the settled `txId` and the `commitmentOpTxId`. You **do not broadcast** the buy — it is already on chain.

```typescript
import {
	buildBuy,
	createIndexerClient,
	requestBuyMultisig,
	MultisigError,
	MULTISIG_TX_MIN_EXPIRATION_MS,
	MULTISIG_TX_MAX_EXPIRATION_MS,
	RECOMMENDED_BUY_TX_EXPIRATION_MS,
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

// 1. Build the tx and pin its expiration inside [MIN, MAX]; 60s is the
//    recommended sweet spot (~RECOMMENDED_BUY_TX_EXPIRATION_MS).
const tx = new hive.Transaction();
await tx.create(result.operations as [string, object][]);
tx.transaction.expiration = new Date(
	Date.now() + RECOMMENDED_BUY_TX_EXPIRATION_MS,
).toISOString().slice(0, 19);

// 2. Buyer signs the full tx with active key BEFORE POSTing.
tx.sign(hive.PrivateKey.from(process.env.HIVE_ACTIVE_KEY!));

// 3. Hand off to the node. It validates, broadcasts the buy_commitment,
//    waits for inclusion, co-signs, and broadcasts the settled buy itself.
const resp = await requestBuyMultisig(INDEXER, {
	transaction: tx.transaction,
});
if (!resp.ok) throw new MultisigError({ message: resp.message, code: resp.code, url: INDEXER });

console.log("Buy settled:", resp.txId, "commitment:", resp.commitmentOpTxId);
```

> The request body is just `{ transaction }`. The buyer account is derived server-side from the first transfer's `from` field; carrying a separate `buyer` would reintroduce a drift vector.

### With Hive Keychain

Sign the buy transaction with Keychain first (`requestSignTx` / `requestSignedTx`, version-dependent) to obtain the buyer's active signature, then POST the resulting signed transaction to `/api/multisig/buy`. You never call `requestBroadcast` for buys — the indexer broadcasts the settled transaction itself once its commitment wins the race.

### Multisig error handling

```typescript
try {
	const resp = await requestBuyMultisig(INDEXER, request);
} catch (err) {
	if (err instanceof MultisigError) {
		switch (err.code) {
			case "NFT_LOCKED":                    // another buy is in flight on this node
			case "CROSS_NODE_RESERVATION":        // another settlement node won the commitment race
			case "COMMITMENT_INCLUSION_TIMEOUT":  // our commitment never made it into a block
			case "RATE_LIMITED":                  // back off err.retryAfterMs
			case "INDEXER_LAGGED":                // node's DB is behind Hive head
			case "NODE_NOT_ACTIVE":               // node missed too many heartbeats
			case "POW_REQUIRED":                  // bump difficulty with { powBits: 20 }
				break;
		}
	}
}
```

The node will refuse to serve a buy if:

- the listing is no longer `listed` (unlisted, expired, or already sold),
- the buyer's signature is missing or the transaction is malformed,
- the payment split in the transaction does not match its own computation,
- the indexer is more than `BUY_API_LAG_MAX_BLOCKS` (3 blocks, ~9 s) behind Hive head,
- the transaction `expiration` falls outside `[MULTISIG_TX_MIN_EXPIRATION_MS, MULTISIG_TX_MAX_EXPIRATION_MS]` (90–120 s),
- it is not currently an active settlement node (missed too many heartbeats).

## Flow 3 — Creating a collection (dual-signer)

`buildCollection` returns **two operations**: a `transfer` signed by the creator (active), and a `custom_json` whose `required_auths` is the node account. Both must be in the **same Hive transaction** — the indexer pairs the fee to the payload by `tx_id`.

```
operations[0] = ["transfer",    { from: "alice", to: "nftlox", amount: "0.100 HBD", memo: "NFTLox FEE-COL:col_…" }]
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
| `/api/multisig/buy` returns `BUYER_SIGNATURE_MISSING` | You POSTed an unsigned transaction. Sign it with the buyer's active key **before** calling `requestBuyMultisig`. |
| Indexer returns `invalid` with `SCHEMA_MISMATCH` | `immutableData`/`mutableData` has extra keys or wrong types. Validate against `client.getCollection(id).schema`. |
| Indexer `invalid` with `NFT_NOT_FOUND` | Using a seed before it is indexed — poll `getOperationStatus` first. |
| Multisig returns `INVALID_PAYMENT_SPLIT` | You computed the split instead of using `getPaymentInfo`. |
| Multisig returns `INDEXER_LAGGED` | Indexer is more than `BUY_API_LAG_MAX_BLOCKS` (3 blocks) behind Hive head. Retry or switch indexer. |
| Multisig returns `CROSS_NODE_RESERVATION` | Another settlement node won the `buy_commitment` ordering race for this NFT. Retry — by then the listing has already been sold (and `NFT_NOT_LISTED` will follow) or the commitment window expired. |

## See also

- [SDK Reference](sdk/reference.md) — full list of builders and return types.
- [Data Formats](data-formats.md) — on-chain payload shape for every action.
- [Error Codes](reference/errors.md) — every `ValidationError` code and multisig `MultisigErrorCode`.

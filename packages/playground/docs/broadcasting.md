# Broadcasting NFTLox Operations to the Hive Blockchain

The NFTLox SDK builds unsigned `custom_json` operations for you. Your job is to **sign them with your Hive private key** and **broadcast the transaction** to any Hive RPC node.

This guide shows complete, working examples for three popular JavaScript/TypeScript libraries.

---

## Key Concepts

### Operations are unsigned

The NFTLox API and SDK return raw Hive operations in this format:

```json
["custom_json", {
	"required_auths": [],
	"required_posting_auths": ["myaccount"],
	"id": "nftlox_testnet",
	"json": "{\"protocol\":\"nftlox_testnet\",\"version\":\"0.4.1\",\"action\":\"mint\",\"data\":{...}}"
}]
```

You are responsible for wrapping them in a transaction, signing, and broadcasting.

### Which key to use

The protocol uses active-key `custom_json` for node-cosigned `create_collection` and `buy`. Other SDK protocol `custom_json` operations use posting keys.

| Key required | Actions |
|---|---|
| **Active key** | `create_collection`, `buy` |
| **Posting key** | `mint`, `bulk_distribute`, `transfer`, `set_data`, `extend_schema`, `archive_collection`, `node_register`, `list`, `unlist`, `nft_approve`, `nft_approve_all`, `nft_transfer_from`, `set_data_from`, `nft_lend`, `nft_return`, `data_operator_approve` |

Active-key actions use `required_auths` while posting-key actions use `required_posting_auths` in the `custom_json` operation.

### RPC nodes

You can broadcast to any public Hive API node:

| Node | URL |
|---|---|
| hive.blog | `https://api.hive.blog` |
| deathwing | `https://api.deathwing.me` |
| hive.ausbit | `https://hive-api.arcange.eu` |
| aswap | `https://api.openhive.network` |

### Transaction limits

- **Maximum 5 operations per transaction** (`MAX_OPERATIONS_PER_TX = 5`)
- Wait **3-4 seconds** between transactions to allow block confirmation (`TX_DELAY_MS = 4000`)
- Each `custom_json` payload must be under **8 KB** (the SDK enforces this automatically)

---

## 1. hive-tx (lightweight, used by NFTLox internally)

`hive-tx` is a minimal, dependency-light library for building and signing Hive transactions. It works in Node.js and the browser.

### Install

```bash
npm install hive-tx
```

### Single operation -- mint one seed

```typescript
import { Transaction, PrivateKey } from "hive-tx";

async function broadcastSingleOperation() {
	// 1. Create transaction
	const tx = new Transaction();

	// 2. Add the custom_json operation
	//    Note: seed IDs MUST start with "seed_" or include nftType: "seed"
	await tx.addOperation("custom_json", {
		required_auths: [],
		required_posting_auths: ["myaccount"],
		id: "nftlox_testnet",
		json: JSON.stringify({
			protocol: "nftlox_testnet",
			version: "0.5.3",
			action: "mint",
			data: {
				id: "seed_abc123",
				collectionId: "col_xyz",
				nftType: "seed",
				edition: 1,
				owner: "myaccount",
				// ... remaining mint fields
			},
		}),
	});

	// 3. Sign with posting key
	const key = PrivateKey.from("5K...your_posting_key_wif");
	tx.sign(key);

	// 4. Broadcast
	const result = await tx.broadcast();
	console.log("Transaction ID:", result.result.tx_id);

	return result;
}

broadcastSingleOperation();
```

### Batch operations -- 5 mints in one transaction

```typescript
import { Transaction, PrivateKey } from "hive-tx";

const MAX_OPERATIONS_PER_TX = 5;
const TX_DELAY_MS = 4000;

interface SdkOperation {
	required_auths: string[];
	required_posting_auths: string[];
	id: string;
	json: string;
}

function chunkArray<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function broadcastBatch(operations: SdkOperation[]) {
	const key = PrivateKey.from("5K...your_posting_key_wif");
	const batches = chunkArray(operations, MAX_OPERATIONS_PER_TX);
	const txIds: string[] = [];

	for (let i = 0; i < batches.length; i++) {
		const tx = new Transaction();

		// Add each operation in the batch
		for (const op of batches[i]!) {
			await tx.addOperation("custom_json", op);
		}

		tx.sign(key);
		const result = await tx.broadcast();

		const txId = result.result.tx_id;
		txIds.push(txId);
		console.log(`Batch ${i + 1}/${batches.length} -- tx: ${txId}`);

		// Wait for block confirmation before next batch
		if (i < batches.length - 1) {
			await delay(TX_DELAY_MS);
		}
	}

	return txIds;
}
```

### Getting the transaction ID

```typescript
const result = await tx.broadcast();
const txId = result.result.tx_id;
```

---

## 2. @hiveio/dhive (popular, well-documented)

`dhive` is a widely-used Hive client with built-in support for transaction building, signing, and broadcasting.

### Install

```bash
npm install @hiveio/dhive
```

### Single operation -- mint one seed

```typescript
import { Client, PrivateKey } from "@hiveio/dhive";

const client = new Client([
	"https://api.hive.blog",
	"https://api.deathwing.me",
]);

const operation = ["custom_json", {
	required_auths: [],
	required_posting_auths: ["myaccount"],
	id: "nftlox_testnet",
	json: JSON.stringify({
		protocol: "nftlox_testnet",
		version: "0.5.3",
		action: "mint",
		data: {
			id: "seed_abc123",
			collectionId: "col_xyz",
			nftType: "seed",
			edition: 1,
			owner: "myaccount",
		},
	}),
}] as const;

async function broadcastSingleOperation() {
	const POSTING_KEY = PrivateKey.fromString("5K...your_posting_key_wif");

	// dhive handles transaction creation, signing, and broadcasting in one call
	const result = await client.broadcast.sendOperations(
		[operation],
		POSTING_KEY,
	);

	console.log("Transaction ID:", result.id);
	console.log("Block number:", result.block_num);

	return result;
}

broadcastSingleOperation();
```

### Batch operations -- 5 mints in one transaction

```typescript
import { Client, PrivateKey } from "@hiveio/dhive";

const client = new Client(["https://api.hive.blog"]);

const MAX_OPERATIONS_PER_TX = 5;
const TX_DELAY_MS = 4000;

function chunkArray<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function broadcastBatch(operations: any[]) {
	const POSTING_KEY = PrivateKey.fromString("5K...your_posting_key_wif");
	const batches = chunkArray(operations, MAX_OPERATIONS_PER_TX);
	const txIds: string[] = [];

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];

		const result = await client.broadcast.sendOperations(batch, POSTING_KEY);

		txIds.push(result.id);
		console.log(`Batch ${i + 1}/${batches.length} -- tx: ${result.id}`);

		if (i < batches.length - 1) {
			await delay(TX_DELAY_MS);
		}
	}

	return txIds;
}

// sdkOperations: array of NFTLox operations
broadcastBatch(sdkOperations);
```

### Manual transaction building (if you need more control)

```typescript
import { Client, PrivateKey, Transaction } from "@hiveio/dhive";

const client = new Client(["https://api.hive.blog"]);

async function broadcastManual() {
	const POSTING_KEY = PrivateKey.fromString("5K...your_posting_key_wif");

	// Get dynamic global properties for ref_block
	const props = await client.database.getDynamicGlobalProperties();

	const tx: Transaction = {
		ref_block_num: props.head_block_number & 0xFFFF,
		ref_block_prefix: Buffer.from(props.head_block_id, "hex").readUInt32LE(4),
		expiration: new Date(
			new Date(props.time + "Z").getTime() + 60 * 1000
		).toISOString().slice(0, -5),
		operations: [
			["custom_json", {
				required_auths: [],
				required_posting_auths: ["myaccount"],
				id: "nftlox_testnet",
				json: JSON.stringify({
					protocol: "nftlox_testnet",
					version: "0.5.3",
					action: "mint",
					data: { /* ... */ },
				}),
			}],
		],
		extensions: [],
	};

	// Sign the transaction
	const signedTx = client.broadcast.sign(tx, POSTING_KEY);

	// Broadcast
	const result = await client.broadcast.send(signedTx);

	console.log("Transaction ID:", result.id);
	return result;
}

broadcastManual();
```

### Getting the transaction ID

`sendOperations` and `send` both return a `TransactionConfirmation` object:

```typescript
const result = await client.broadcast.sendOperations([operation], key);
const txId = result.id;          // "a1b2c3d4e5f6..."
const blockNum = result.block_num; // 12345678
```

---

## 3. @hiveio/wax (official Hive library, newest)

`wax` is the official Hive library maintained by the core team. It uses a typed operation format with `_operation` suffixed keys. For key management, it integrates with `@hiveio/beekeeper`.

### Install

```bash
npm install @hiveio/wax @hiveio/beekeeper
```

### Single operation -- mint one seed

```typescript
import { createHiveChain, createWaxFoundation } from "@hiveio/wax";
import beekeeperFactory from "@hiveio/beekeeper";

async function broadcastSingleOperation() {
	// Initialize the chain connection
	const chain = await createHiveChain();

	// Set up Beekeeper for key management
	const beekeeper = await beekeeperFactory();
	const session = beekeeper.createSession("session-salt");
	const { wallet } = await session.createWallet("nftlox-wallet");

	// Import your posting key (WIF format)
	const POSTING_KEY_WIF = "5K...your_posting_key_wif";
	const publicKey = await wallet.importKey(POSTING_KEY_WIF);

	// Create a transaction (auto-fetches ref_block from the network)
	const tx = await chain.createTransaction();

	// Push the NFTLox custom_json operation using the wax typed format
	tx.pushOperation({
		custom_json: {
			required_auths: [],
			required_posting_auths: ["myaccount"],
			id: "nftlox_testnet",
			json: JSON.stringify({
				protocol: "nftlox_testnet",
				version: "0.5.3",
				action: "mint",
				data: {
					id: "seed_abc123",
					collectionId: "col_xyz",
					nftType: "seed",
					edition: 1,
					owner: "myaccount",
				},
			}),
		},
	});

	// Sign the transaction using the wallet
	tx.sign(wallet, publicKey);

	// Broadcast
	await chain.broadcast(tx);

	// Get the transaction in API form (includes the tx hash)
	const apiForm = tx.toApi();
	console.log("Transaction broadcast successfully");
	console.log("API form:", apiForm);

	// Cleanup
	beekeeper.delete();
}

broadcastSingleOperation();
```

### Signing without Beekeeper (manual)

If you don't want to use Beekeeper for key management, you can sign manually using `sigDigest` and `addSignature`:

```typescript
import { createHiveChain } from "@hiveio/wax";

async function broadcastWithManualSigning() {
	const chain = await createHiveChain();
	const tx = await chain.createTransaction();

	tx.pushOperation({
		custom_json: {
			required_auths: [],
			required_posting_auths: ["myaccount"],
			id: "nftlox_testnet",
			json: JSON.stringify({
				protocol: "nftlox_testnet",
				version: "0.5.3",
				action: "mint",
				data: {
					id: "seed_abc123",
					collectionId: "col_xyz",
					nftType: "seed",
					edition: 1,
					owner: "myaccount",
				},
			}),
		},
	});

	// Get the digest to sign
	const digest = tx.sigDigest;

	// Sign with your own signing method (e.g., secp256k1 library)
	const signature = yourSigningFunction(digest, privateKey);

	// Attach the signature
	tx.addSignature(signature);

	// Broadcast
	await chain.broadcast(tx);
	console.log("Transaction ID:", tx.id);
}
```

This is useful when integrating with external key management systems or hardware wallets.

### Batch operations -- 5 mints in one transaction

```typescript
import { createHiveChain } from "@hiveio/wax";
import beekeeperFactory from "@hiveio/beekeeper";

const MAX_OPERATIONS_PER_TX = 5;
const TX_DELAY_MS = 4000;

function chunkArray<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Each sdkOperation is the raw NFTLox format:
// ["custom_json", { required_auths, required_posting_auths, id, json }]
// We convert them to the wax typed format when pushing.

interface NftloxRawOperation {
	required_auths: string[];
	required_posting_auths: string[];
	id: string;
	json: string;
}

async function broadcastBatch(rawOperations: [string, NftloxRawOperation][]) {
	const chain = await createHiveChain();

	const beekeeper = await beekeeperFactory();
	const session = beekeeper.createSession("session-salt");
	const { wallet } = await session.createWallet("nftlox-wallet");

	const POSTING_KEY_WIF = "5K...your_posting_key_wif";
	const publicKey = await wallet.importKey(POSTING_KEY_WIF);

	const batches = chunkArray(rawOperations, MAX_OPERATIONS_PER_TX);

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const tx = await chain.createTransaction();

		// Push each operation from the batch
		for (const [, opBody] of batch) {
			tx.pushOperation({
				custom_json: {
					required_auths: opBody.required_auths,
					required_posting_auths: opBody.required_posting_auths,
					id: opBody.id,
					json: opBody.json,
				},
			});
		}

		// Sign and broadcast
		tx.sign(wallet, publicKey);
		await chain.broadcast(tx);

		console.log(`Batch ${i + 1}/${batches.length} broadcast successfully`);

		if (i < batches.length - 1) {
			await delay(TX_DELAY_MS);
		}
	}

	beekeeper.delete();
}

// Usage
broadcastBatch(sdkOperations);
```

### Converting NFTLox SDK format to wax format

The NFTLox SDK returns operations in the standard Hive API format (array tuples). The wax library uses a typed object format. Here is how to convert:

```typescript
// NFTLox SDK returns this:
const sdkOperation = ["custom_json", {
	required_auths: [],
	required_posting_auths: ["myaccount"],
	id: "nftlox_testnet",
	json: "{ ... }",
}];

// For wax pushOperation, use this:
const waxOperation = {
	custom_json: {
		required_auths: sdkOperation[1].required_auths,
		required_posting_auths: sdkOperation[1].required_posting_auths,
		id: sdkOperation[1].id,
		json: sdkOperation[1].json,
	},
};

tx.pushOperation(waxOperation);
```

### Getting the transaction ID

After signing, use `toApi()` to get the full transaction in API form:

```typescript
tx.sign(wallet, publicKey);

// The API form is a JSON string containing the full transaction
const apiForm = tx.toApi();
const parsed = JSON.parse(apiForm);
// parsed contains: ref_block_num, ref_block_prefix, expiration, operations, signatures
```

The transaction ID (hash) is computed from the signed transaction. After broadcasting with `chain.broadcast(tx)`, the transaction is on-chain and can be looked up by its signature digest.

---

## Quick Comparison

| Feature | hive-tx | @hiveio/dhive | @hiveio/wax |
|---|---|---|---|
| Bundle size | Small | Medium | Large (includes WASM) |
| Key handling | Raw WIF string | `PrivateKey` class | Beekeeper wallet |
| Transaction creation | `new Transaction()` | `sendOperations()` | `chain.createTransaction()` |
| Operation format | Array tuples | Array tuples | Typed objects |
| Browser support | Yes | Yes | Yes (needs WASM) |
| Node.js support | Yes | Yes | Yes |
| Maintained by | Community | Community | Hive core team |

---

## Common Patterns

### Waiting for confirmation

After broadcasting a transaction, you may want to verify it was included in a block. The simplest approach is to wait for one block cycle (3 seconds):

```typescript
const TX_DELAY_MS = 4000;

async function broadcastAndConfirm(broadcastFn: () => Promise<string>) {
	const txId = await broadcastFn();
	// Wait for block inclusion
	await new Promise((resolve) => setTimeout(resolve, TX_DELAY_MS));
	return txId;
}
```

### Error handling

All three libraries throw errors on broadcast failure. Common failure reasons:

- **Missing required authority** -- wrong key type (posting vs active). Remember: `buy` needs active key; other SDK protocol `custom_json` operations use posting key.
- **Duplicate transaction** -- same operation already in a pending block
- **Expired transaction** -- transaction was created too long ago (> 60 seconds)
- **RC (Resource Credits) insufficient** -- account does not have enough RC to broadcast

```typescript
try {
	await broadcast();
} catch (error) {
	if (error.message.includes("missing required posting authority") || error.message.includes("missing required active authority")) {
		console.error("Wrong key -- check if this action requires posting or active key");
	} else if (error.message.includes("rc_plugin")) {
		console.error("Insufficient Resource Credits -- claim or delegate RC first");
	} else if (error.message.includes("expired")) {
		console.error("Transaction expired -- recreate and try again");
	} else {
		console.error("Broadcast error:", error.message);
	}
}
```

### Using active key for active-key operations

The `buy` operation requires active key. Active-key operations use `required_auths` instead of `required_posting_auths`:

```typescript
// The operation format for active-key actions
const activeKeyOperation = ["custom_json", {
	required_auths: ["myaccount"],        // active key
	required_posting_auths: [],           // empty
	id: "nftlox_testnet",
	json: JSON.stringify({ /* ... */ }),
}];

// hive-tx example
const ACTIVE_KEY = "5K...your_active_key_wif";
const tx = new Transaction();
await tx.create([activeKeyOperation]);
tx.sign(ACTIVE_KEY);
await tx.broadcast();

// dhive example
const ACTIVE_KEY = PrivateKey.fromString("5K...your_active_key_wif");
await client.broadcast.sendOperations([activeKeyOperation], ACTIVE_KEY);

// wax example
const activePublicKey = await wallet.importKey("5K...your_active_key_wif");
tx.sign(wallet, activePublicKey);
await chain.broadcast(tx);
```

---

## Full End-to-End Example: Mint a Collection + 5 Seeds

This example uses `hive-tx` and the NFTLox SDK to create a collection and then mint 5 seeds in a single batch:

```typescript
import { Transaction, config } from "hive-tx";
import {
	createDeterministicCollectionPayload,
	createDeterministicMintOperation,
	toHiveOperation,
} from "@nftlox/sdk";

config.node = "https://api.hive.blog";

const POSTING_KEY = "5K...your_posting_key_wif";
const MAX_OPERATIONS_PER_TX = 5;
const TX_DELAY_MS = 4000;

async function mintCollectionAndSeeds() {
	// Step 1: Broadcast the collection creation
	const collectionPayload = await createDeterministicCollectionPayload({
		creator: "myaccount",
		name: "My Game Cards",
		symbol: "CARDS",
		totalPotential: 1000,
		metadata: {
			description: "A trading card game collection",
			image: "https://example.com/collection.png",
		},
		rules: {
			transferable: true,
			burnable: true,
			royaltyPct: 5,
			royaltyRecipient: "myaccount",
		},
	});
	const collectionOp = toHiveOperation(collectionPayload, "myaccount");

	const collectionTx = new Transaction();
	await collectionTx.create([collectionOp]);
	collectionTx.sign(POSTING_KEY);
	const collectionResult = await collectionTx.broadcast();
	console.log("Collection created:", collectionResult.result.id);

	// Wait for the collection to be confirmed
	await new Promise((resolve) => setTimeout(resolve, TX_DELAY_MS));

	// Step 2: Mint 5 seeds in a single transaction (within the 5-op limit)
	// Use createDeterministicMintOperation to get seed_* IDs and nftType: "seed"
	const mintOps = [];
	for (let edition = 1; edition <= 5; edition++) {
		const mintOp = createDeterministicMintOperation({
			artId: `card${String(edition).padStart(3, "0")}`,
			collectionId: "col_xyz",
			collectionOriginDna: "abcdef1234567890",
			edition,
			owner: "myaccount",
			nftType: "seed",
			name: `Card #${edition}`,
			description: `Game card edition ${edition}`,
			imageUrl: `https://example.com/cards/${edition}.png`,
			maxSupply: 100,
		});
		mintOps.push(mintOp);
	}

	const mintTx = new Transaction();
	await mintTx.create(mintOps);
	mintTx.sign(POSTING_KEY);
	const mintResult = await mintTx.broadcast();
	console.log("5 seeds minted:", mintResult.result.id);
}

mintCollectionAndSeeds();
```

---

## Security Notes

- **Never expose private keys in client-side code.** Use environment variables or a secure key management system.
- For browser-based applications, consider using [Hive Keychain](https://hive-keychain.com/) which handles signing without exposing keys.
- The examples above use raw WIF keys for clarity. In production, use `.env` files or secret managers.
- The `@hiveio/wax` Beekeeper integration provides an additional layer of key isolation.

# Getting Started with NFTLox

This guide walks you through making your first API calls to the NFTLox protocol on Hive blockchain.

## Prerequisites

- **Hive account** -- You need a Hive blockchain account. Create one at [signup.hive.io](https://signup.hive.io).
- **Active key** -- Required for operations that move value: `transfer`, `burn`, `list`, `buy`, `pack_buy`, `pack_transfer`, `nft_approve`, `nft_approve_all`, `pack_approve`, and `data_operator_approve`.
- **Posting key** -- Required for the remaining operations: `create_collection`, `mint`, `replicate`, `bulk_distribute`, `set_data`, `set_owner_data`, `extend_schema`, `unlist`, `pack_create`, `pack_open`, `nft_transfer_from`, `pack_transfer_from`, `set_data_from`, `nft_lend`, and `nft_return`.
- Your private keys never leave your client; the API only builds unsigned payloads.

## Your First API Call

The NFTLox API is publicly available at:

```
https://api-nftlox.hivecreators.co/api/
```

Check the protocol status to confirm the indexer is running:

```bash
curl https://api-nftlox.hivecreators.co/api/status
```

Response:

```json
{
	"protocolVersion": "0.4.0",
	"protocolId": "nftlox_testnet",
	"genesisBlock": 12345678,
	"nodeAccount": "nftlox",
	"multisigEnabled": true,
	"lastBlock": 98765432,
	"headBlock": 98765435,
	"blocksBehind": 3,
	"inSync": true
}
```

## Reading Data

All read endpoints are `GET` requests. No authentication is required.

### Get protocol statistics

```bash
curl https://api-nftlox.hivecreators.co/api/stats
```

Returns aggregate counts: total collections, NFTs, seeds, instances, replicas, listed, burned, and unique owners.

### List all collections

```bash
curl "https://api-nftlox.hivecreators.co/api/collections?limit=20&offset=0"
```

Supports optional query parameters:
- `creator` -- filter by Hive username
- `limit` -- results per page (1-200, default 50)
- `offset` -- pagination offset (default 0)

### Get a single NFT by ID

```bash
curl https://api-nftlox.hivecreators.co/api/nfts/YOUR_NFT_ID
```

Returns full NFT details including metadata, ownership, listing info, DNA, and structured data.

### Get a user's NFTs

```bash
curl "https://api-nftlox.hivecreators.co/api/users/YOUR_USERNAME/nfts?limit=50&offset=0"
```

Supports optional filters:
- `status` -- `active`, `listed`, or `burned`
- `type` -- `seed`, `instance`, or `replica`
- `limit` -- results per page (1-200, default 50)
- `offset` -- pagination offset (default 0)

Returns the NFTs along with aggregate count breakdowns.

### Get a user's collections

```bash
curl "https://api-nftlox.hivecreators.co/api/users/YOUR_USERNAME/collections?limit=50"
```

### Get marketplace listings

```bash
curl "https://api-nftlox.hivecreators.co/api/marketplace/listings?sort=recent&currency=HIVE&limit=20"
```

## Building Transactions

The build API constructs unsigned Hive `custom_json` operations. It validates your input, generates deterministic IDs, and returns a payload ready to be signed and broadcast. The server never touches your private keys.

### Example: Create a collection

```bash
curl -X POST https://nftloxtest.hivecreators.co/api/build/collection \
	-H "Content-Type: application/json" \
	-d '{
		"creator": "your-hive-user",
		"name": "My Collection",
		"symbol": "MYCOL",
		"totalPotential": 100,
		"metadata": {
			"description": "A sample NFT collection",
			"image": "https://example.com/cover.png"
		},
		"rules": {
			"transferable": true,
			"burnable": true,
			"replicable": false,
			"royaltyPct": 5
		}
	}'
```

Response:

```json
{
	"success": true,
	"protocolVersion": "0.4.0",
	"hashVersion": "v1",
	"collectionId": "deterministic-id-here",
	"generatedIds": { "collectionId": "..." },
	"operation": ["custom_json", { ... }],
	"payload": {
		"protocol": "nftlox_testnet",
		"version": "0.4.0",
		"action": "create_collection",
		"data": { ... }
	}
}
```

The `operation` field is a ready-to-broadcast Hive operation. If validation fails, you get `success: false` with an `errors` array describing each issue.

### Available build endpoints

All build endpoints accept `POST` with a JSON body:

| Endpoint | Description | Key Type |
|---|---|---|
| `/api/build/collection` | Create a new collection | Posting |
| `/api/build/seeds` | Batch-mint seed NFTs | Posting |
| `/api/build/bulk-distribute` | Distribute instances to users | Posting |
| `/api/build/transfer` | Transfer an NFT | Active |
| `/api/build/list` | List NFT for sale | Active |
| `/api/build/unlist` | Remove listing | Posting |
| `/api/build/burn` | Burn an NFT | Active |
| `/api/build/buy` | Buy a listed NFT | Active |
| `/api/build/replicate` | Replicate a seed | Posting |
| `/api/build/set-data` | Update mutable data (creator) | Posting |
| `/api/build/set-owner-data` | Update owner-specific data | Posting |
| `/api/build/extend-schema` | Add fields to collection schema | Posting |
| `/api/build/pack-create` | Create a pack | Posting |
| `/api/build/pack-buy` | Buy packs | Active |
| `/api/build/pack-open` | Open packs | Posting |
| `/api/build/pack-transfer` | Transfer packs | Active |
| `/api/build/nft-approve` | Approve NFT operator | Active |
| `/api/build/nft-approve-all` | Approve operator for collection | Active |
| `/api/build/nft-transfer-from` | Operator transfers NFT | Posting |
| `/api/build/pack-approve` | Approve pack operator | Active |
| `/api/build/pack-transfer-from` | Operator transfers packs | Posting |
| `/api/build/nft-lend` | Lend an NFT | Posting |
| `/api/build/nft-return` | Return a lent NFT | Posting |
| `/api/build/data-operator-approve` | Approve data operator | Active |
| `/api/build/set-data-from` | Operator updates data | Posting |
| `/api/build/preview-ids` | Preview deterministic IDs | -- |

## Signing and Broadcasting

The build API returns an unsigned `operation`. You must sign it with the appropriate Hive key (active or posting, depending on the endpoint -- see the table above) and broadcast it to a Hive RPC node.

Use any Hive signing library. Here is a minimal TypeScript example using `dhive`:

```typescript
import { Client, PrivateKey } from "@hiveio/dhive";

const client = new Client("https://api.hive.blog");

async function signAndBroadcast(
	operation: [string, Record<string, unknown>],
	signerAccount: string,
	privateKey: string,
): Promise<void> {
	const key = PrivateKey.fromString(privateKey);

	const result = await client.broadcast.sendOperations(
		[operation],
		key,
	);

	console.log("Broadcast OK, tx ID:", result.id);
}

// Usage with a build API response:
const buildResponse = await fetch("https://nftloxtest.hivecreators.co/api/build/transfer", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		nftId: "my-nft-id",
		from: "alice",
		to: "bob",
	}),
}).then(r => r.json());

if (buildResponse.success) {
	await signAndBroadcast(
		buildResponse.operation,
		"alice",
		"5K...your-active-key...",
	);
}
```

The transaction is broadcast to `https://api.hive.blog` (or any Hive RPC node). Once included in a block, the NFTLox indexer picks it up and updates state within seconds.

## Key Concepts

### Seeds vs Instances

NFTLox uses a two-tier model:

- **Seed** -- The original NFT. Think of it as a master template. A seed has a `maxSupply` that limits how many instances can be distributed from it.
- **Instance** -- A copy distributed from a seed via `bulk_distribute`. Each instance gets a unique `instanceDna` and `instanceNumber`. Instances are full NFTs that can be transferred, listed, and burned independently.
- **Replica** -- Created via `replicate`. Similar to instances but created on-demand from a seed.

### Deterministic IDs

All IDs in NFTLox are deterministic -- they are derived from the creator, collection name, symbol, and art IDs using cryptographic hashing. This means:

- You can predict an NFT's ID before minting it.
- Duplicate mints of the same data are impossible (the indexer rejects them).
- Use `/api/build/preview-ids` to compute IDs without building a full transaction.

### immutableData vs mutableData

Collections with a typed schema support structured data on each NFT:

- **immutableData** -- Set at mint time, can never be changed. Use for permanent attributes like rarity, generation, or base stats.
- **mutableData** -- Can be updated by the collection creator (or an approved data operator) via `set_data`. Use for dynamic attributes like level, XP, or equipment.
- **ownerData** -- Can be updated by the current NFT owner. Use for personalization like nicknames or display preferences.

The schema is defined at collection creation and enforces field names and types. The indexer validates all data mutations against the schema.

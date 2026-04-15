# Allowances & Operators

NFTLox implements an ERC-721-style approval system that lets NFT owners delegate transfer authority to third parties, and a separate data operator system that lets collection creators delegate mutable data writes.

---

## Permission Types

| Permission | Scope | Grantor | Use case |
|------------|-------|---------|----------|
| NFT Approve | Single NFT instance | Owner | Marketplace escrow, P2P trades |
| NFT Approve All | All NFTs in a collection | Owner | Marketplace blanket approval |
| Data Operator | Collection-wide data writes | Creator | Game servers, oracle feeds |

**Key principle:** Approve, transfer-from, and set-data-from operations use `required_posting_auths` (posting key). Do not keep active keys on a server for delegation flows.

---

## NFT Approve

Grant or revoke a spender's permission to transfer a single NFT on your behalf.

### Validation rules

- Spender cannot be the signer (no self-approval).
- NFT must exist, not be burned, lent, or a seed.
- Signer must be the current owner.
- Setting `approved: false` deletes the allowance entirely.

### API

`POST /api/build/nft-approve`

```json
{
	"owner": "alice",
	"spender": "marketplace-bot",
	"instanceId": "nft_a1b2c3d4_1_ef56",
	"approved": true
}
```

**Response:**

```json
{
	"success": true,
	"protocolVersion": "0.5.2",
	"operation": ["custom_json", { "..." }],
	"keyType": "Posting"
}
```

### SDK

```typescript
import { buildNftApprove } from "nftlox-sdk";

const result = buildNftApprove({
	owner: "alice",
	spender: "marketplace-bot",
	instanceId: "nft_a1b2c3d4_1_ef56",
	approved: true,
});

if (result.success) {
	// result.operation -- ready to sign and broadcast
	// result.payload   -- raw protocol payload
}
```

---

## NFT Approve All

Grant or revoke a spender's permission to transfer **all** NFTs you own within a specific collection.

### Validation rules

- Spender cannot be the signer.
- Collection must exist and not be archived.
- Setting `approved: false` deletes the collection allowance.

### API

`POST /api/build/nft-approve-all`

```json
{
	"owner": "alice",
	"spender": "marketplace-bot",
	"collectionId": "col_a1b2c3d4",
	"approved": true
}
```

### SDK

```typescript
import { buildNftApproveAll } from "nftlox-sdk";

const result = buildNftApproveAll({
	owner: "alice",
	spender: "marketplace-bot",
	collectionId: "col_a1b2c3d4",
	approved: true,
});
```

---

## NFT Transfer From

Transfer an NFT on behalf of its owner, using either an individual NFT approval or a collection-wide approval.

### Validation rules

- `from` must be the current owner of the NFT.
- `from` and `to` cannot be the same account.
- NFT must not be burned, lent, listed (expired listings are auto-cleared), or a distributed seed.
- Collection must be transferable.
- Signer must have **either** an individual NFT allowance **or** a collection-wide allowance for the NFT's collection.
- After transfer, the individual NFT allowance is cleared (collection allowance persists).

### API

`POST /api/build/nft-transfer-from`

```json
{
	"spender": "marketplace-bot",
	"from": "alice",
	"to": "bob",
	"instanceId": "nft_a1b2c3d4_1_ef56"
}
```

Optional provenance fields: `seedId`, `seedTxId`.

> **Note:** The `spender` field in the request body maps to `operator` internally in the builder.

### SDK

```typescript
import { buildNftTransferFrom } from "nftlox-sdk";

const result = buildNftTransferFrom({
	operator: "marketplace-bot",
	from: "alice",
	to: "bob",
	instanceId: "nft_a1b2c3d4_1_ef56",
});
```

---

## Data Operator Approve

Authorize a Hive account to update mutable data on NFTs within your collection. This is completely separate from NFT transfer allowances -- data operators cannot transfer NFTs.

### Validation rules

- Operator cannot be the signer (no self-approval).
- Collection must exist and not be archived.
- **Only the collection creator** can approve data operators.
- Setting `approved: false` revokes the operator.

### API

`POST /api/build/data-operator-approve`

```json
{
	"creator": "ragnarok-game",
	"collectionId": "col_a1b2c3d4",
	"operator": "game-server-1",
	"approved": true
}
```

### SDK

```typescript
import { buildDataOperatorApprove } from "nftlox-sdk";

const result = buildDataOperatorApprove({
	creator: "ragnarok-game",
	collectionId: "col_a1b2c3d4",
	operator: "game-server-1",
	approved: true,
});
```

---

## Set Data From

Update mutable data on an NFT as an authorized data operator. Requires a prior `data-operator-approve`.

### Validation rules

- NFT must exist and not be burned.
- `instanceDna` must match the NFT's current DNA.
- Signer must be an approved data operator for the NFT's collection.
- Collection must have a schema.
- `mutableData` must contain at least one field for schema-based collections.
- Fields are validated against the collection schema and merged with existing data.

### API

`POST /api/build/set-data-from`

```json
{
	"operator": "game-server-1",
	"nftId": "nft_a1b2c3d4_1_ef56",
	"instanceDna": "A1B2C3D4E5F6G7",
	"mutableData": {
		"level": 5,
		"xp": 2450
	}
}
```

Optional provenance fields: `seedId`, `seedTxId`.

### SDK

```typescript
import { createSetDataFromOperation, type SetDataFromInput } from "nftlox-sdk";

const input: SetDataFromInput = {
	nftId: "nft_a1b2c3d4_1_ef56",
	instanceDna: "A1B2C3D4E5F6G7",
	mutableData: {
		level: 5,
		xp: 2450,
	},
};

const operation = createSetDataFromOperation(input, "game-server-1");
// Sign with game-server-1's posting key and broadcast
```

---

## Revoking Permissions

All approval types support revocation by setting `approved: false`.

### Revoke NFT approval

```typescript
buildNftApprove({
	owner: "alice",
	spender: "marketplace-bot",
	instanceId: "nft_a1b2c3d4_1_ef56",
	approved: false,
});
```

### Revoke collection-wide approval

```typescript
buildNftApproveAll({
	owner: "alice",
	spender: "marketplace-bot",
	collectionId: "col_a1b2c3d4",
	approved: false,
});
```

### Revoke data operator

```typescript
buildDataOperatorApprove({
	creator: "ragnarok-game",
	collectionId: "col_a1b2c3d4",
	operator: "game-server-1",
	approved: false,
});
```

### Implicit revocations

Some operations clear allowances automatically:

| Event | Effect |
|-------|--------|
| NFT Transfer From | Individual NFT allowance is cleared (collection allowance stays) |
| NFT Transfer (direct) | Individual NFT allowance is cleared |
| Collection archived | All collection allowances and data operators are removed |

---

## Database Tables

For reference, the indexer maintains these tables:

| Table | Key | Description |
|-------|-----|-------------|
| `nft_allowances` | `nft_id` (unique) | Single NFT approvals. One spender per NFT. |
| `collection_allowances` | `(owner, spender, collection_id)` | Collection-wide approvals. |
| `data_operators` | `(collection_id, operator)` | Authorized data operators. |

# nftlox-sdk

Builder and client library for NFTLox. It produces unsigned Hive operations,
queries indexer state, exposes multisig helpers, and verifies ownership edges
against Hive L1. The SDK never handles private keys.

## Install

The package is currently tested from the monorepo:

```bash
git clone https://github.com/enrique89ve/nftlox.git nftlox
cd nftlox
bun install
```

After npm publication:

```bash
bun add nftlox-sdk
# or: npm install nftlox-sdk
```

## Quick start

```typescript
import { createNftloxClient, expireIn } from "nftlox-sdk";

const client = createNftloxClient({
	indexerUrl: "https://api-nftlox.hivecreators.co",
});

const inventory = await client.indexer.getUserNfts("alice");
const result = await client.builders.list({
	nftId: inventory.nfts[0]!.id,
	owner: "alice",
	price: { amount: "10.000", currency: "HIVE" },
	expiresAt: expireIn({ days: 14 }),
});

if (!result.success) throw new Error(JSON.stringify(result.errors));
// Sign and broadcast result.operations with Hive Keychain, hive-tx, wax, or dhive.
```

## What the SDK owns

- Builders and Zod input schemas.
- Deterministic IDs, DNA, schema, payment, and sizing helpers.
- Typed indexer queries.
- The `create_collection` and node-last `buy` multisig clients.
- SPV verification helpers.

The wire contract belongs to [`@nftlox/protocol`](../protocol/README.md). Do
not hard-code action authorities or protocol limits in an application.

## Documentation

- [SDK Overview](../playground/docs/sdk/overview.md) — mental model and flows.
- [SDK Reference](../playground/docs/sdk/reference.md) — builders, helpers, and types.
- [Signing & Broadcasting](../playground/docs/broadcasting.md) — signer-specific examples.
- [Game Development](../playground/docs/use-cases/games.md) — complete integration path.
- [Protocol Reference](../protocol/README.md) — canonical wire contract.

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build the package |
| `bun run test` | Run SDK tests |
| `bun run typecheck` | Type-check the package |

## License

MIT

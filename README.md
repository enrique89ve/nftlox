# NFTLox

NFTLox is a self-custodial NFT protocol on Hive L1. Applications build typed,
deterministic `custom_json` operations, users sign them with their own Hive
keys, and indexers reconstruct queryable state from the chain.

## Why NFTLox

- **No smart contracts or gas:** protocol operations use Hive `custom_json` and
  Hive Resource Credits.
- **The chain stays authoritative:** PostgreSQL is an indexer projection, not
  the asset itself.
- **Deterministic assets:** collections, seeds, instances, listings, and DNA
  can be derived client-side from public inputs.
- **Non-custodial game primitives:** schemas, seed distribution, mutable data,
  lending, and approvals compose without handing custody to the game server.
- **Verifiable settlement:** SPV checks resolve ownership edges against Hive;
  marketplace buys are atomic node-last multisig transactions.

## How it works

```text
Your app → nftlox-sdk → signed Hive transaction → Hive L1
                                                    ↓
                         indexer ← validates and projects operations
                            ↓
                     REST API / PostgreSQL
```

The SDK never holds private keys. Most actions are signed and broadcast by the
caller. `create_collection` and `buy` use the indexer only for their narrow
node-multisig flows.

## Packages

| Package | Role |
|---|---|
| [`@nftlox/protocol`](./packages/protocol) | Normative wire types, actions, authorities, limits, IDs, and schemas |
| [`nftlox-sdk`](./packages/sdk) | Builders, clients, signing metadata, multisig helpers, and SPV |
| [`nftlox-packs-engine`](./packages/packs-engine) | Optional off-chain pack planning that emits `bulk_distribute` items |
| [`@nftlox/indexer`](./packages/indexer) | Hive scanner, deterministic projection, PostgreSQL, and REST API |
| [`@nftlox/playground`](./packages/playground) | Hive Keychain test harness and documentation server |

## Run locally

```bash
bun install
bun run dev:indexer       # PostgreSQL via Docker
bun run dev:playground    # in another terminal
```

Open <http://localhost:3040> and the indexer Swagger UI at
<http://localhost:3050/swagger>.

## Documentation

Start with the [developer documentation](./packages/playground/docs/):

1. [Getting Started](./packages/playground/docs/getting-started.md)
2. [Using the SDK](./packages/playground/docs/sdk/overview.md)
3. [Signing & Broadcasting](./packages/playground/docs/broadcasting.md)
4. [Protocol Reference](./packages/protocol/README.md)
5. [API Reference](./packages/playground/docs/reference/api.md)

For complete game flows, see [Game Development](./packages/playground/docs/use-cases/games.md).
For indexer deployment, see the [deployment guide](./packages/playground/docs/contributing/indexer-deployment.md).

The implementation in `packages/protocol` is the protocol source of truth. If
prose and code differ, follow the code and update the relevant guide.

## Development

This is a Bun workspaces monorepo:

```bash
bun run test
bun run test:sdk
bun run test:indexer
bun run typecheck
```

## License

MIT

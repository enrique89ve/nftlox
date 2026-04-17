# NFTLox

> Polymorphic ownership infrastructure on Hive blockchain. Encode NFT operations as deterministic `custom_json` on Hive L1 and reconstruct state through indexing — no smart contracts, no gas fees.

Traditional NFT protocols force you into rigid smart contract environments. NFTLox takes a different approach: operations are deterministic `custom_json` payloads on Hive L1, and protocol state is reconstructed by indexing them. The result is fast, free to transact, and fully verifiable.

If you are building a game with collectible cards, items, or characters, NFTLox gives you typed schemas, seed/instance distribution, and mutable data fields your game server can update in real time — all anchored to an L1 blockchain with 3-second finality.

## Features

- **No smart contracts** — operations are `custom_json` on Hive L1; the protocol is enforced by deterministic indexing.
- **Typed schemas** — define immutable, mutable, and owner-editable fields per collection with strict validation.
- **Seed / instance model** — mint a seed template, distribute instances from it; each instance gets unique deterministic DNA.
- **Zero transaction fees** — Hive L1 uses resource credits, not gas; end users pay nothing.
- **3-second finality** — operations confirmed in the next Hive block.
- **Composable operators** — lending, allowances, and data operators let game servers act on behalf of users.
- **Built-in marketplace** — list, buy, and unlist with multisig buyer protection.
- **SPV verification** — browser-side trustless verification against Hive L1.

## Packages

| Package | Description | Port |
|---|---|---|
| [`packages/sdk`](./packages/sdk) | Core protocol library — types, payloads, builders, multisig, SPV | — |
| [`packages/packs-engine`](./packages/packs-engine) | Optional external library for pack definition and `bulk_distribute` planning | — |
| [`packages/indexer`](./packages/indexer) | Blockchain scanner + PostgreSQL + REST API + Swagger | 3050 |
| [`packages/playground`](./packages/playground) | Web UI for testing with Hive Keychain (also serves the public docs site) | 3040 |

## Architecture

```
Your App                              Hive L1
--------                              -------

  SDK / fetch()                       custom_json operation
       |                                    |
       v                                    v
  Build payload  ─── builds ──────>   Broadcast to
  (unsigned)                          Hive RPC node
                                            |
                                            v
                                       NFTLox indexer
                                       (reads L1, validates,
                                        reconstructs state)
                                            |
                                            v
  Query API  <─── reads state ──────  PostgreSQL
  (public, no auth)
```

**Write path:** build an unsigned payload via the SDK, sign client-side with a Hive key (Keychain or otherwise), broadcast to any Hive RPC node. The indexer detects the operation and updates state.

**Read path:** query the indexer REST API for collections, NFTs, users, marketplace listings, and operators. No authentication required.

## Quick start

```bash
bun install
bun run dev:indexer       # auto-launches PostgreSQL via Docker
bun run dev:playground    # in another terminal
```

Open the playground at <http://localhost:3040> and the indexer Swagger UI at <http://localhost:3050/swagger>.

## Documentation

The canonical NFTLox documentation site lives in [`packages/playground/docs/`](./packages/playground/docs/). Suggested reading order:

- [Getting Started](./packages/playground/docs/getting-started.md) — first API call, mint an NFT in under 5 minutes.
- [Game Integration](./packages/playground/docs/game-integration.md) — full game-developer walkthrough.
- [SDK Functions](./packages/playground/docs/sdk-functions.md) — exports, builders, schemas.
- [API Endpoints](./packages/playground/docs/api-endpoints.md) — full REST reference.

For deployment of the indexer (Docker, Compose, Dokploy, Nginx, build-image), see [`packages/playground/docs/contributing/indexer-deployment.md`](./packages/playground/docs/contributing/indexer-deployment.md).

## Development

This is a **Bun workspaces** monorepo. SDK changes are immediately visible to the indexer and playground via workspace links — no publishing needed.

```bash
bun run test          # all tests
bun run test:sdk      # one package
bun run test:indexer  # indexer-only
bun run typecheck     # all packages
```

Contributor guides live under [`packages/playground/docs/contributing/`](./packages/playground/docs/contributing/) (development workflow, database migrations, indexer deployment).

## License

MIT

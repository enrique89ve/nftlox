# NFTLox

Monorepo for the **NFTLox Protocol** -- Polymorphic Ownership infrastructure on Hive blockchain.

## Packages

| Package | Description | Port |
|---------|-------------|------|
| [`packages/sdk`](./packages/sdk) | Core protocol library (types, payloads, DNA, builders, multisig, SPV) | -- |
| [`packages/indexer`](./packages/indexer) | Blockchain scanner + PostgreSQL + REST API + Swagger | 3050 |
| [`packages/playground`](./packages/playground) | Web UI for testing with Hive Keychain | 3040 |

## Quick Start

```bash
# Install all dependencies
bun install

# Start the indexer (auto-launches PostgreSQL via Docker)
bun run dev:indexer

# Start the playground
bun run dev:playground
```

## Development Workflow

This is a **Bun workspaces** monorepo. Changes in the SDK are immediately available to the indexer and playground -- no publishing needed.

```bash
# Run all tests
bun run test

# Run tests for a specific package
bun run test:sdk
bun run test:indexer

# TypeScript check all packages
bun run typecheck
```

### Making SDK Changes

1. Edit files in `packages/sdk/src/`
2. Run `bun run test:sdk` to verify
3. The indexer and playground automatically see the changes (workspace link)

### Adding a New Protocol Action

1. Add the action constant in `packages/sdk/src/constants.ts`
2. Add the type in `packages/sdk/src/types.ts`
3. Create the payload function in `packages/sdk/src/payloads.ts`
4. Add Zod schema in `packages/sdk/src/schemas.ts`
5. Add builder in `packages/sdk/src/builders/`
6. Export from `packages/sdk/src/index.ts`
7. Add handler in `packages/indexer/src/processor/handlers/`
8. Register in `packages/indexer/src/processor/action-router.ts`

## Architecture

```
Hive Blockchain (L1)
    |
    v
packages/sdk ─────────── Types, Payloads, Builders, Multisig, SPV
    |                         |
    v                         v
packages/indexer          packages/playground
    |                         |
    v                         v
PostgreSQL + REST API     Browser UI + Keychain
(port 3050 + Swagger)     (port 3040)
    ^
    |
SPV "Boleto Suizo" ──── Trustless verification via HAFAH REST API
(browser verifies L1)
```

## Protocol Features

- **25 protocol actions**: Core, Marketplace, Packs, Allowances, Lending, Data Operators
- **Multisig buy**: Node co-signs buy transactions to protect buyer funds (HIVE transfers + NFT transfer are atomic)
- **Deterministic RNG**: All indexers produce identical results from the same blockchain data
- **SPV Verification**: Browser-side trustless verification against Hive L1
- **NFT Lending**: Protocol-level lend/return without ownership transfer
- **Cross-Game Composability**: Data operators can write to NFTs across games

## License

MIT

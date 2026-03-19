# NFTLox

Monorepo for the **NFTLox Protocol** — Polymorphic Ownership infrastructure on Hive blockchain.

## Packages

| Package | Description | Port |
|---------|-------------|------|
| [`packages/sdk`](./packages/sdk) | Core protocol library (types, payloads, DNA, validation) | — |
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

This is a **Bun workspaces** monorepo. Changes in the SDK are immediately available to the indexer and playground — no publishing needed.

```bash
# Run all tests (113 tests across SDK + indexer)
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
4. Export from `packages/sdk/src/index.ts`
5. Add handler in `packages/indexer/src/processor/handlers/`
6. Register in `packages/indexer/src/processor/action-router.ts`

## Architecture

```
Hive Blockchain
    |
    v
packages/sdk ─────────── Types, Payloads, Validation
    |                         |
    v                         v
packages/indexer          packages/playground
    |                         |
    v                         v
PostgreSQL + REST API     Browser UI + Keychain
(port 3050 + Swagger)     (port 3040)
```

## License

MIT

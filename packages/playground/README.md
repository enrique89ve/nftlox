# @nftlox/playground

> Browser harness for testing NFTLox actions with Hive Keychain. Also serves the public documentation site.

**Default port:** 3040

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Hive Keychain](https://hive-keychain.com/) browser extension
- NFTLox indexer running on port 3050

## Quick start

```bash
bun install
bun run dev:playground
```

Open <http://localhost:3040>. The playground requires the Hive Keychain browser extension.

## What it demonstrates

- Creating collections with metadata, rules, and typed schemas.
- Automated collection + seeds creation (backend workflow with `buildCollectionWithSeeds`).
- Minting seeds with deterministic IDs and anti-duplication.
- Bulk distributing instances from seeds.
- Transferring, burning, listing, buying NFTs (multisig buy with node co-signature).
- Lending / returning NFTs at protocol level.
- NFT approvals, collection-wide approvals, and data operators.
- SPV trustless verification of ownership against Hive L1.
- Debug endpoints for server-side signing and end-to-end multisig flow.

## Routes

### Query API (indexer proxy)

Proxies the indexer REST API — users, NFTs, collections, marketplace listings, stats, status, health.

### Build API (22 endpoints)

All `POST /api/build/*` endpoints that validate input and return Hive operations ready for Keychain signing: `collection`, `seeds`, `bulk-distribute`, `transfer`, `list`, `unlist`, `buy`, `burn`, `set-data`, `extend-schema`, `archive-collection`, `node-register`, `node-heartbeat`, `nft-approve`, `nft-approve-all`, `nft-transfer-from`, `nft-lend`, `nft-return`, `data-operator-approve`, `set-data-from`, `preview-ids`, `collection-multisig`.

### Other APIs

| Endpoint | Description |
|---|---|
| `POST /api/spv/verify-ownership` | SPV ownership verification |
| `POST /api/spv/verify-on-chain` | SPV on-chain verification |
| `POST /api/validate/pre-mint` | Pre-mint validation |
| `GET /api/protocol/version` | Protocol version info |
| `POST /api/debug/server-transfer` | Server-only signing test (no Keychain) |
| `POST /api/debug/multisig-buy` | End-to-end multisig buy flow |

## Public documentation site

The `docs/` directory inside this package is the canonical NFTLox documentation site (Docsify). It is the single source of truth for all shareable documentation — public, contributor, and protocol spec.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `INDEXER_URL` | `http://localhost:3050` | Indexer API base URL |
| `HIVE_ACCOUNT` | (empty) | Hive account for debug server signing |
| `ACTIVE_KEY` | (empty) | Active key for debug server signing |

## Scripts

| Script | Description |
|---|---|
| `bun run dev` | Start the playground (dev) |
| `bun run start` | Start the playground (prod) |

## License

MIT

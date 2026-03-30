# NFTLox Playground

Web UI for testing the NFTLox Protocol on Hive blockchain. Vanilla HTML/TypeScript frontend served by a Bun HTTP server that proxies the indexer API and builds Hive operations via the SDK.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Hive Keychain](https://hive-keychain.com/) browser extension
- NFTLox Indexer running on port 3050

## Quick Start

```bash
# From the monorepo root
bun install
bun run dev:playground
```

Open `http://localhost:3040` in your browser.

## Features

- **Collections**: Create collections with metadata and rules
- **Minting**: Mint seed NFTs with deterministic IDs and anti-duplication
- **Distribution**: Bulk distribute instances from seeds
- **Transfers**: Transfer NFTs with atomic notifications (0.001 HIVE)
- **Marketplace**: List, unlist, and browse listings
- **Multisig buy**: Purchase NFTs via node co-signed transactions (cosign with indexer node)
- **Packs**: Create, buy, open, and transfer packs
- **Lending**: Lend/return NFTs at protocol level
- **Permissions**: NFT approvals, collection-wide approvals, data operators
- **SPV Verification**: Trustless verification of ownership, transactions, and pack opens against Hive L1
- **NFT Tracker**: BlockTrades standard metadata operations
- **Search**: Look up users and NFTs
- **Debug**: Test server-side signing and multisig buy flow end-to-end

## Routes

### Query API (Indexer proxy)

| Endpoint | Description |
|----------|-------------|
| `GET /api/user/:username` | User's NFTs |
| `GET /api/user/:username/collections` | User's collections |
| `GET /api/user/:username/packs` | User's pack balances |
| `GET /api/nft/:nftId` | NFT details |
| `GET /api/nft/:nftId/details` | NFT with parent/instances |
| `GET /api/collections` | All collections |
| `GET /api/collection/:id` | Collection details |
| `GET /api/collection/:id/nfts` | Collection NFTs |
| `GET /api/collection/:id/stats` | Collection statistics |
| `GET /api/collection/:id/exists` | Collection existence check |
| `GET /api/seed/:seedId/instances` | Seed instances |
| `GET /api/seed/:id/exists` | Seed existence check |
| `GET /api/marketplace/listings` | Active listings |
| `GET /api/packs` | All packs |
| `GET /api/pack/:id` | Pack details |
| `GET /api/stats` | Protocol stats |
| `GET /api/status` | Sync status |
| `GET /api/health` | Health check |

### Build API (26 endpoints)

All `POST` endpoints that validate input and return Hive operations ready for Keychain signing:

| Endpoint | Action |
|----------|--------|
| `/api/build/collection` | Create collection |
| `/api/build/seeds` | Mint seed batch |
| `/api/build/bulk-distribute` | Bulk distribute |
| `/api/build/transfer` | Transfer NFT |
| `/api/build/list` | List on marketplace |
| `/api/build/unlist` | Remove listing |
| `/api/build/buy` | Buy NFT |
| `/api/build/burn` | Burn NFT |
| `/api/build/replicate` | Create replica |
| `/api/build/set-data` | Update mutable data (creator) |
| `/api/build/set-owner-data` | Update owner-specific data |
| `/api/build/extend-schema` | Add fields to collection schema |
| `/api/build/preview-ids` | Preview deterministic IDs |
| `/api/build/pack-create` | Create pack |
| `/api/build/pack-buy` | Buy pack |
| `/api/build/pack-open` | Open pack |
| `/api/build/pack-transfer` | Transfer pack |
| `/api/build/nft-approve` | Approve NFT spender |
| `/api/build/nft-approve-all` | Approve collection-wide |
| `/api/build/nft-transfer-from` | Transfer as spender |
| `/api/build/pack-approve` | Approve pack spending |
| `/api/build/pack-transfer-from` | Transfer pack as spender |
| `/api/build/nft-lend` | Lend NFT |
| `/api/build/nft-return` | Return lent NFT |
| `/api/build/data-operator-approve` | Approve data operator |
| `/api/build/set-data-from` | Write data as operator |

### Debug API

| Endpoint | Description |
|----------|-------------|
| `POST /api/debug/server-transfer` | Server-only signing test (no Keychain) |
| `POST /api/debug/multisig-buy` | End-to-end multisig buy flow (builds tx, gets node signature) |

### Other APIs

| Endpoint | Description |
|----------|-------------|
| `POST /api/spv/verify-ownership` | SPV ownership verification |
| `POST /api/spv/verify-on-chain` | SPV on-chain verification |
| `POST /api/spv/verify-pack-open` | SPV pack-open verification |
| `POST /api/validate/pre-mint` | Pre-mint validation |
| `GET /api/protocol/version` | Protocol version info |
| `GET /api/protocol/info` | Full protocol info |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_URL` | `http://localhost:3050` | Indexer API base URL |
| `HIVE_ACCOUNT` | (empty) | Hive account for debug server signing |
| `ACTIVE_KEY` | (empty) | Active key for debug server signing |

## License

MIT

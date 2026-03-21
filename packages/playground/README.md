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
- **Marketplace**: List, unlist, buy, make/accept/reject offers
- **Packs**: Create, buy, open, and transfer packs
- **Lending**: Lend/return NFTs at protocol level
- **Permissions**: NFT approvals, collection-wide approvals, data operators
- **SPV Verification**: Trustless verification of ownership, transactions, and pack opens against Hive L1
- **NFT Tracker**: BlockTrades standard metadata operations
- **Search**: Look up users and NFTs
- **History**: Full NFT event history and ownership chain

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_URL` | `http://localhost:3050` | Indexer API base URL |

## License

MIT

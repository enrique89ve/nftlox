# NFTLox Playground

Web UI for testing the [NFTLox Protocol](https://github.com/enrique89ve/nftlox-sdk) on Hive blockchain. Create collections, mint NFTs, distribute instances, transfer, list on marketplace — all through a browser interface.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Hive Keychain](https://hive-keychain.com/) browser extension

## Quick Start

```bash
git clone https://github.com/enrique89ve/nftlox-playground.git
cd nftlox-playground
bun install
bun run dev
```

Open `http://localhost:3040` in your browser.

## Features

- Create collections with metadata and rules
- Mint seed NFTs (deterministic IDs, anti-duplication)
- Batch minting with session persistence
- Distribute instances from seeds
- Transfer NFTs with atomic notifications (0.001 HIVE)
- List/unlist on marketplace
- View NFT history and ownership chain
- Real-time blockchain state via HafSQL

## Related Projects

- [nftlox-sdk](https://github.com/enrique89ve/nftlox-sdk) — Protocol core library
- [nftlox-indexer](https://github.com/enrique89ve/nftlox-indexer) — Blockchain indexer + REST API

## License

MIT

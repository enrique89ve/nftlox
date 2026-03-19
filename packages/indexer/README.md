# NFTLox Indexer

Blockchain indexer for the [NFTLox Protocol](https://github.com/enrique89ve/nftlox-hive). Scans Hive blockchain block by block, validates protocol transactions, and maintains queryable state in PostgreSQL with a REST API + OpenAPI docs.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL)

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/enrique89ve/nftlox-indexer.git
cd nftlox-indexer
bun install

# 2. Start everything (auto-launches PostgreSQL via Docker)
bun run dev
```

That's it. The indexer will:
- Start PostgreSQL in Docker (if not already running)
- Begin syncing from the genesis block
- Serve the REST API on `http://localhost:3050`
- Serve Swagger UI on `http://localhost:3050/swagger`

## Commands

```bash
bun run dev          # Start with hot reload (auto-starts PostgreSQL)
bun run start        # Start in production mode
bun test             # Run all tests
bun run test:unit    # Unit tests only (no DB required)
bun run test:integration  # Integration tests (requires PostgreSQL)
bun run typecheck    # TypeScript type check

./db.sh up           # Start PostgreSQL manually
./db.sh down         # Stop PostgreSQL
./db.sh reset        # Reset database (delete all data)
./db.sh logs         # View PostgreSQL logs
```

## REST API

Interactive documentation available at `http://localhost:3050/swagger`

### Status
| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Sync progress (lastBlock, headBlock, blocksBehind) |
| `GET /api/stats` | Protocol totals (collections, NFTs, sales, etc.) |

### Collections
| Endpoint | Description |
|----------|-------------|
| `GET /api/collections` | List all (?limit=50&offset=0) |
| `GET /api/collections/:id` | Collection details |
| `GET /api/collections/:id/nfts` | NFTs in collection (?type=seed) |
| `GET /api/collections/:id/stats` | Aggregated statistics |

### NFTs
| Endpoint | Description |
|----------|-------------|
| `GET /api/nfts/:id` | NFT details |
| `GET /api/nfts/:id/history` | Event history |
| `GET /api/nfts/:id/ownership` | Ownership chain (provenance) |
| `GET /api/nfts/:id/instances` | Instances (if seed) |
| `GET /api/nfts/:id/offers` | Offers on this NFT |

### Users
| Endpoint | Description |
|----------|-------------|
| `GET /api/users/:username/nfts` | User's NFTs (?status=active&type=seed) |
| `GET /api/users/:username/collections` | User's collections |
| `GET /api/users/:username/activity` | User's activity feed |

### Marketplace
| Endpoint | Description |
|----------|-------------|
| `GET /api/marketplace/listings` | Active listings (?sort=price_asc&currency=HIVE) |
| `GET /api/marketplace/recent-sales` | Recent sales |

## Configuration

Copy `.env.example` to `.env` to customize (defaults work out of the box):

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | 3050 | REST API port |
| `DATABASE_URL` | postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer | PostgreSQL connection |
| `GENESIS_BLOCK` | 90000000 | First block to scan |
| `PROTOCOL_ID` | nftlox_testnet | Protocol ID to filter |
| `BATCH_SIZE` | 1000 | Blocks per API request (max 1000) |
| `SYNC_INTERVAL_MS` | 3000 | Polling interval when caught up |
| `LOG_LEVEL` | info | debug, info, warn, error |

## Architecture

```
Hive Blockchain
    |
    v
+------------------+
|  Scanner         |  Fetches blocks via @hiveio/wax
|  (hive-client)   |  Failover across multiple endpoints
|  (op-parser)     |  Filters custom_json + atomic transfers
|  (sync-engine)   |  Batch loop with PostgreSQL transactions
+--------+---------+
         |
         v
+------------------+
|  Processor       |  Validates operations
|  (action-router) |  Routes to 13 handlers
|  (handlers/)     |  Mutates DB state
+--------+---------+
         |
         v
+------------------+
|  PostgreSQL      |  collections, nfts, history_events,
|  (Docker)        |  offers, invalid_operations
+--------+---------+
         |
         v
+------------------+
|  REST API        |  Elysia + OpenAPI/Swagger
|  (routes/)       |  Collections, NFTs, Users, Marketplace
+------------------+
```

### Key Design Decisions

- **Batch processing**: Up to 1000 blocks per API request, processed in a single PostgreSQL transaction for atomicity
- **Idempotent**: All inserts use `ON CONFLICT DO NOTHING` — safe to restart at any point
- **Failover**: Rotates between 3 Hive API endpoints with exponential backoff
- **Anti-spam**: Duplicate detection at handler level + unique constraints in DB
- **Audit trail**: Invalid operations are logged to `invalid_operations` table with failure reason

## Protocol Actions

| Action | Description | Validation |
|--------|-------------|------------|
| `create_collection` | Create NFT collection | ID must not exist |
| `mint` | Mint seed NFT | Collection must exist, ID unique |
| `distribute` | Create instance from seed | Seed exists, supply not exceeded, signer is owner |
| `transfer` | Transfer ownership | NFT exists, not burned, signer is owner |
| `burn` | Destroy NFT | NFT exists, not already burned, signer is owner |
| `list` | List on marketplace | NFT exists, not burned, signer is owner |
| `unlist` | Remove listing | NFT is listed, signer is owner |
| `buy` | Purchase listed NFT | NFT is listed, buyer != owner |
| `replicate` | Create replica | Original exists, not burned |
| `set_data` | Update custom data | NFT exists, not burned, signer is owner |
| `offer` | Make offer on NFT | NFT exists, offerer != owner |
| `accept_offer` | Accept offer | Offer is active, signer is owner |
| `reject_offer` | Reject offer | Offer is active, signer is owner |

## Testing

```bash
# Run all tests (31 tests)
bun test

# Unit tests — operation parser (no DB needed)
bun run test:unit

# Integration tests — handlers against real PostgreSQL
bun run test:integration
```

## License

MIT

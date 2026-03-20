# NFTLox Indexer

Blockchain indexer for the [NFTLox Protocol](https://github.com/enrique89ve/nftlox). Scans Hive blockchain block by block, validates protocol transactions, and maintains queryable state in PostgreSQL with a REST API + OpenAPI docs.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL)

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/enrique89ve/nftlox.git
cd nftlox
bun install

# 2. Start everything (auto-launches PostgreSQL via Docker)
bun run dev:indexer
```

That's it. The indexer will:
- Start PostgreSQL in Docker (if not already running)
- Begin syncing from the genesis block
- Serve the REST API on `http://localhost:3050`
- Serve Swagger UI on `http://localhost:3050/swagger` (dev only)

## REST API

Interactive documentation available at `http://localhost:3050/swagger` (disabled in production).

### Status & Health
| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Sync progress (lastBlock, headBlock, blocksBehind) |
| `GET /api/health` | Sync-aware health check (200 healthy, 503 unhealthy) |
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
| `GET /api/nfts/:id/history` | Event history (?cursor=lastId for efficient pagination) |
| `GET /api/nfts/:id/ownership` | Ownership chain (provenance) |
| `GET /api/nfts/:id/instances` | Instances (if seed) |
| `GET /api/nfts/:id/offers` | Offers on this NFT |

### Users
| Endpoint | Description |
|----------|-------------|
| `GET /api/users/:username/nfts` | User's NFTs (?status=active&type=seed) |
| `GET /api/users/:username/collections` | User's collections |
| `GET /api/users/:username/activity` | User's activity feed (?cursor=lastId) |
| `GET /api/users/:username/packs` | User's pack balances |

### Marketplace
| Endpoint | Description |
|----------|-------------|
| `GET /api/marketplace/listings` | Active listings (?sort=price_asc&currency=HIVE) |
| `GET /api/marketplace/recent-sales` | Recent sales (?cursor=lastId) |

### Packs
| Endpoint | Description |
|----------|-------------|
| `GET /api/packs` | List packs (?collectionId=xxx) |
| `GET /api/packs/:id` | Pack details |
| `GET /api/packs/:id/history` | Pack history (?cursor=lastId) |

### Pagination

All list endpoints support `?limit=N&offset=N`. History endpoints also support cursor-based pagination with `?cursor=lastId` for O(1) performance on large tables.

## Configuration

Copy `.env.example` to `.env` to customize (defaults work out of the box):

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | 3050 | REST API port |
| `DATABASE_URL` | postgres://...localhost:5432/nftlox_indexer | PostgreSQL connection |
| `GENESIS_BLOCK` | 90000000 | First block to scan |
| `PROTOCOL_ID` | nftlox_testnet | Protocol ID to filter |
| `BATCH_SIZE` | 1000 | Blocks per API request |
| `SYNC_INTERVAL_MS` | 3000 | Polling interval when caught up |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `NODE_ENV` | development | Set to `production` for hardened mode |
| `ENABLE_SWAGGER` | true | Disable in production |
| `POSTGRES_PASSWORD` | nftlox_dev | Docker PostgreSQL password |

## Security

- **Rate limiting**: 1000 requests/min per IP (CF-Connecting-IP > X-Real-IP > X-Forwarded-For)
- **Security headers**: X-Content-Type-Options, Referrer-Policy, Cache-Control
- **Query hard caps**: Max 1000 rows per query regardless of client input
- **Swagger**: Disabled when `NODE_ENV=production`
- **Parametrized queries**: All 200+ SQL queries use tagged templates (anti-SQLi)

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
|  (action-router) |  Routes to 29 handlers
|  handlers/       |  core/ marketplace/ packs/ allowances/ lending/
+--------+---------+
         |
         v
+------------------+
|  PostgreSQL      |  collections, nfts, history_events, offers,
|  (Docker)        |  packs, allowances, nft_loans
+--------+---------+
         |
         v
+------------------+
|  REST API        |  Elysia + OpenAPI/Swagger
|  (routes/)       |  Rate limiting, cache headers, health check
+------------------+
```

## Protocol Actions (29)

### Core (7)
| Action | Description |
|--------|-------------|
| `create_collection` | Create NFT collection |
| `mint` | Mint seed NFT |
| `distribute` | Create instance from seed |
| `transfer` | Transfer ownership |
| `burn` | Destroy NFT |
| `replicate` | Create replica |
| `set_data` | Update custom data/tags |

### Marketplace (6)
| Action | Description |
|--------|-------------|
| `list` | List on marketplace |
| `unlist` | Remove listing |
| `buy` | Purchase listed NFT |
| `offer` | Make offer |
| `accept_offer` | Accept offer |
| `reject_offer` | Reject offer |

### Packs (4)
| Action | Description |
|--------|-------------|
| `pack_create` | Create pack with drop table |
| `pack_buy` | Buy pack |
| `pack_transfer` | Transfer pack |
| `pack_open` | Open pack (deterministic RNG) |

### Allowances (5)
| Action | Description |
|--------|-------------|
| `nft_approve` | Approve spender for single NFT |
| `nft_approve_all` | Approve spender for entire collection |
| `nft_transfer_from` | Transfer NFT as approved spender |
| `pack_approve` | Approve pack spending |
| `pack_transfer_from` | Transfer pack as approved spender |

### Lending (2)
| Action | Description |
|--------|-------------|
| `nft_lend` | Lend NFT (status=lent, blocks transfer/burn/list) |
| `nft_return` | Return lent NFT (lender or borrower can return) |

### Data Operators (2)
| Action | Description |
|--------|-------------|
| `data_operator_approve` | Authorize external app to write data |
| `set_data_from` | Write data as approved operator (cross-game) |

## Testing

```bash
bun test
```

## License

MIT

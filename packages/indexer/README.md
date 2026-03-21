# NFTLox Indexer

Blockchain indexer for the [NFTLox Protocol](https://github.com/enrique89ve/nftlox). Scans Hive blockchain block by block, validates protocol transactions, and maintains queryable state in PostgreSQL with a REST API + OpenAPI docs.

## How It Works

```
Alice owns sword_42. She lends it to Bob for a tournament.

nft_lend { instanceId: "sword_42", borrower: "bob" }
  -> Bob can use sword_42 in-game
  -> Bob CANNOT transfer, sell, or burn it
  -> Alice or Bob can return it at any time
nft_return { instanceId: "sword_42" }
  -> sword_42 is back with Alice, full history preserved
```

**Lending** -- NFTs can be lent without transferring ownership. The protocol blocks transfers, sales, and burns while lent. No escrow, no smart contract.

**Data Operators** -- A game can write stats to an NFT it didn't create. The owner approves an operator once; from then on, that operator can call `set_data_from` on any of the owner's NFTs. The owner's economic rights never change.

```
data_operator_approve { operator: "chess_game", collectionId: "col_abc" }
set_data_from { instanceId: "sword_42", data: { wins: 12, elo: 1450 } }
  -> chess_game writes to sword_42
  -> Alice still owns it, can sell it with the stats attached
```

**Scalability** -- The indexer reads Hive L1 and projects state into PostgreSQL. This means SQL joins, sorting, filtering, and pagination over millions of NFTs -- things that are impossible querying raw blockchain JSON.

**SPV Verification ("Boleto Suizo")** -- The client doesn't trust the indexer blindly. It picks random events, fetches the original transaction from Hive L1 via HAFAH, replays the deterministic logic locally, and compares the result. If they match, the indexer is honest.

```
Client                         Indexer              Hive L1
  |--- pick random pack_open --->|                      |
  |<-- here's what happened -----|                      |
  |--- fetch same tx directly ---|--------------------->|
  |<-- raw transaction ----------|------- HAFAH --------|
  |                                                     |
  [replay RNG locally]                                  |
  [compare result]                                      |
  -> match? indexer is honest                           |
```

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
| `GENESIS_BLOCK` | 103484900 | First block to scan |
| `PROTOCOL_ID` | nftlox_testnet | Protocol ID to filter |
| `BATCH_SIZE` | 1000 | Blocks per API request |
| `SYNC_INTERVAL_MS` | 3000 | Polling interval when caught up |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `NODE_ENV` | development | Set to `production` for hardened mode |
| `ENABLE_SWAGGER` | true | Disabled automatically in production |
| `POSTGRES_DB` | nftlox_indexer | PostgreSQL database name |
| `POSTGRES_USER` | nftlox | PostgreSQL user |
| `POSTGRES_PASSWORD` | nftlox_dev | PostgreSQL password |
| `POSTGRES_PORT` | 5432 | PostgreSQL port |
| `HIVE_ENDPOINTS` | (multiple) | Comma-separated Hive API endpoints |

## Security

- **Rate limiting**: 1000 requests/min per IP (CF-Connecting-IP > X-Real-IP > X-Forwarded-For)
- **Security headers**: X-Content-Type-Options, Referrer-Policy, Cache-Control
- **Query hard caps**: Max 1000 rows per query regardless of client input
- **Swagger**: Disabled when `NODE_ENV=production`
- **Sync gating**: Data endpoints return 503 until indexer is synced
- **Parametrized queries**: All SQL queries use tagged templates (anti-SQLi)

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
|  (action-router) |  Routes to 26 handlers
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

## Protocol Actions (26)

### Core (7)
| Action | Description |
|--------|-------------|
| `create_collection` | Create NFT collection |
| `mint` | Mint seed NFT |
| `bulk_distribute` | Create instances from seed |
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

# NFTLox Indexer

Blockchain indexer for the [NFTLox Protocol](https://github.com/enrique89ve/nftlox). Scans Hive blockchain block by block, validates protocol transactions, and maintains queryable state in PostgreSQL with a REST API + OpenAPI docs.

## Core Principles

- **0 Fees (Hive as Base Layer):** Eliminates the biggest friction in Web3 adoption. Users don't need to buy cryptocurrency just to pay to "move" their character or change its name.
- **Infinite & Dynamic Metadata (Custom JSONs + Memos):** While Ethereum struggles to store a simple string on-chain, nftlox uses Hive JSONs to store the complete state of a game, a weapon's history, or an identity's reputation.
- **Native Security (Multisig):** The node co-signs buy transactions so the buyer's HIVE transfer and the NFT ownership change happen atomically. If the node rejects the transaction, the funds never leave the buyer's account.
- **Zero Smart Contracts (Web2 Development):** Allows game studios to build using TypeScript SDKs and traditional databases (PostgreSQL) for the Indexer, accelerating development x100.
- **Trustless Verification (Light Clients via SDK):** A user doesn't have to blindly trust a game server. Thanks to the SDKs, anyone can connect to a public Hive node, read the immutable history of `custom_json`, and mathematically calculate the exact same state of the NFT (level, owner, attributes) without needing to run a full Indexer themselves.

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

**Data Operators** -- A game can write stats to an NFT it didn't create. The collection creator approves an operator once; from then on, that operator can call `set_data_from` on any NFT in the collection. The NFT owner's economic rights never change.

```
data_operator_approve { operator: "chess_game", collectionId: "col_abc" }
set_data_from { instanceId: "sword_42", data: { wins: 12, elo: 1450 } }
  -> chess_game writes to sword_42
  -> Alice still owns it, can sell it with the stats attached
```

**Multisig Buy** -- Marketplace purchases use a multisig flow. The buyer builds a transaction with HIVE transfers (seller + royalty + fee) and a `buy` custom_json. The indexer node validates the payment split and co-signs with its active key. The buyer then signs with Hive Keychain and broadcasts. Both signatures are required, so funds only move if the NFT transfer also happens.

```
Buyer                          Indexer Node
  |--- GET /api/payment-info --->|  (split: seller + royalty + fee)
  |<-- PaymentInfo --------------|
  |                              |
  [build unsigned tx]            |
  |--- POST /api/multisig ------>|  (validate + sign)
  |<-- nodeSignature ------------|
  |                              |
  [sign with Keychain]           |
  [broadcast to Hive L1]        |
```

**Scalability** -- The indexer reads Hive L1 and projects state into PostgreSQL. This means SQL joins, sorting, filtering, and pagination over millions of NFTs -- things that are impossible querying raw blockchain JSON.

**SPV Verification ("Boleto Suizo")** -- The client doesn't trust the indexer blindly. It picks random events, fetches the original transaction from Hive L1 via HAFAH, replays the deterministic logic locally, and compares the result. If they match, the indexer is honest.

```
Client                         Indexer              Hive L1
  |--- pick random buy ---------->|                      |
  |<-- here's what happened -----|                      |
  |--- fetch same tx directly ---|--------------------->|
  |<-- raw transaction ----------|------- HAFAH --------|
  |                                                     |
  [replay RNG locally]                                  |
  [compare result]                                      |
  -> match? indexer is honest                           |
```

## Prerequisites

- [Bun](https://bun.sh) v1.1+ (required runtime — uses io_uring for async I/O)
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL)

## Related Docs

- [Development Guide](/root/projects/nftlox/docs/contributing/development-guide.md)
- [Database Migration Strategy](/root/projects/nftlox/docs/contributing/database-migrations.md)

## Quick Start

This quick start is the recommended local development flow on Linux, Ubuntu, and WSL:
- PostgreSQL runs in Docker
- the indexer runs on the host with Bun

If you cloned only the indexer as a standalone repository, run `bun install` from that repository root and keep the rest of the flow the same.

```bash
# 1. Clone and install
git clone https://github.com/enrique89ve/nftlox.git
cd nftlox
bun install

# 2. Configure env
cp packages/indexer/.env.example packages/indexer/.env

# 3. Start local development infra
cd packages/indexer
./scripts/compose.sh dev up -d

# 4. Run the indexer on the host
cd ../..
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
| `GET /api/status` | Sync progress (lastBlock, headBlock, blocksBehind, multisigEnabled) |
| `GET /api/health` | Combined health response: HTTP status follows liveness and the JSON includes both `liveness` and `readiness` |
| `GET /api/stats` | Protocol totals (collections, NFTs, listed, burned, etc.) |

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
| `GET /api/nfts/:id/instances` | Instances distributed from this seed |

### Users
| Endpoint | Description |
|----------|-------------|
| `GET /api/users/:username/nfts` | User's NFTs with counts (?status=active&type=seed) |
| `GET /api/users/:username/nfts/count` | NFT counts by type (seeds, instances, replicas) |
| `GET /api/users/:username/collections` | User's collections |

### Marketplace
| Endpoint | Description |
|----------|-------------|
| `GET /api/marketplace/listings` | Active listings (?sort=price_asc&currency=HIVE) |
| `GET /api/marketplace/sales` | Completed sales with financial breakdown (gross, royalty, fee, net) |
| `GET /api/marketplace/volume` | Aggregated marketplace volume statistics |

### Multisig
| Endpoint | Description |
|----------|-------------|
| `GET /api/payment-info/:nftId` | Payment split for building a buy transaction |
| `POST /api/multisig` | Validate and co-sign a buy transaction |

### Schema
| Endpoint | Description |
|----------|-------------|
| `GET /api/collections/:id/schema-history` | Schema version history (hash chain) for a collection |

### Pagination

All list endpoints support `?limit=N&offset=N`.

### Public API Units

- `protocolFeeBps` in `GET /api/status` uses basis points: `100 = 1%`.
- `maxRoyaltyBps` in `GET /api/status` also uses basis points: `5000 = 50%`.
- `royalty_pct` in collection responses remains a whole percent for protocol `0.5.0`.
- Monetary fields such as `listing_price`, `gross_amount`, `royalty_amount`, `protocol_fee`, `seller_net`, `totalPrice`, `sellerAmount`, `royaltyAmount`, and `feeAmount` are Hive asset amounts with 3 decimal places.
- `multisigClockDriftMs` and rate-limit windows are expressed in milliseconds.
- `lastBlock`, `headBlock`, `irreversibleBlock`, and `genesisBlock` are Hive block numbers.

## Configuration

Copy `.env.example` to `.env` and set the chain-specific required values before starting:

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | 3050 | REST API port |
| `GENESIS_BLOCK` | required | First block to scan |
| `BATCH_SIZE` | 1000 | Blocks per API request |
| `SYNC_INTERVAL_MS` | 3000 | Polling interval when caught up |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `NODE_ENV` | development | Set to `production` for hardened mode |
| `ENABLE_SWAGGER` | true | Disabled automatically in production |
| `ALLOWED_ORIGINS` | (empty) | Comma-separated CORS allowlist. Set this in production |
| `POSTGRES_DB` | nftlox_indexer | PostgreSQL database name |
| `POSTGRES_USER` | nftlox | PostgreSQL user |
| `POSTGRES_PASSWORD` | nftlox_dev | PostgreSQL password (required in production) |
| `HIVE_ENDPOINTS` | (multiple) | Comma-separated Hive API endpoints |
| `HIVE_ACCOUNT` | nftlox | Node account (signs buy ops, receives protocol fee) |
| `ACTIVE_KEY` | (empty) | Node's active key for multisig signing (enables multisig) |
| `NODE_URL` | (empty) | Public URL of this node |
| `INDEXER_ROLE` | both | `sync`, `api`, or `both` |
| `MULTISIG_RATE_LIMIT_MAX` | 10 | Max multisig requests per window |
| `MULTISIG_RATE_LIMIT_WINDOW_MS` | 60000 | Rate limit window in milliseconds |
| `MULTISIG_IP_RATE_LIMIT_MAX` | 30 | Max multisig requests per IP and window |
| `MULTISIG_IP_RATE_LIMIT_WINDOW_MS` | 60000 | Per-IP multisig rate limit window in milliseconds |
| `HEALTH_PORT` | 0 | Separate internal health port with `/live` and `/ready` probes (0 = disabled) |

`PROTOCOL_ID` is compiled from the protocol constants and is not configured via environment variables.

## Operational Scripts

The indexer ships small deployment scripts inspired by `docs/reference_repos/nft-tracker-temp`, but adapted to the current Bun/Compose layout:

- `scripts/docker-entrypoint.sh`
  Dispatches container startup in `start`, `monolith`, `sync`, or `api` mode.
- `scripts/docker-healthcheck.sh`
  Uses `/live` on `HEALTH_PORT` when enabled, otherwise falls back to `/api/health`.
- `scripts/dev-env.sh`
  Detects WSL, slow `/mnt/*` paths, and whether Docker is still using the legacy builder.
- `scripts/build-image.sh`
  Builds the standalone indexer image and prefers `docker buildx` when available.
- `scripts/compose.sh`
  Resolves the right compose files for `dokploy`, `server`, or `dev`.

Compose files inject only explicit environment variables per service. This keeps secrets like `ACTIVE_KEY` out of unrelated containers such as PostgreSQL.

The container image is also built from `packages/indexer` itself. It no longer copies SDK runtime sources into the image, and it uses the package-local `bun.lock` for reproducible installs.

`Dockerfile.dokploy` is the hosted-deploy variant for the same `packages/indexer` build context. It pins the Bun patch version used during image builds so `bun install --frozen-lockfile --production` stays consistent with the checked-in lockfile.

Examples:

```bash
cd packages/indexer
./scripts/compose.sh dev up -d
./scripts/compose.sh dokploy up -d
./scripts/compose.sh server up -d
./scripts/build-image.sh nftlox-indexer
DOCKER_SUBNET=172.28.10.0/24 ./scripts/compose.sh dokploy up -d
DOCKER_BUILD_NETWORK=host ./scripts/build-image.sh nftlox-indexer
```

`dev` mode means:
- PostgreSQL in Docker
- indexer on the host with `bun run dev:indexer`

On WSL, the scripts will warn if:
- the repo is under `/mnt/*`
- Docker is still using the legacy builder instead of `buildx`

For the fastest local workflow on WSL, prefer:
- `./scripts/compose.sh dev up -d`
- run the indexer on the Linux host with `bun run dev:indexer`

If image builds stall on HTTPS downloads in WSL or another host with problematic Docker bridge networking, retry the image build with:

```bash
DOCKER_BUILD_NETWORK=host ./scripts/build-image.sh nftlox-indexer
```

That override is a troubleshooting fallback, not the default production configuration.

## Production Deployment

Two deployment modes are available. Both use the same base `docker-compose.yml`.
In production, the base compose keeps PostgreSQL and the indexer on the internal Docker network. Traffic should enter through your platform proxy or the optional Nginx overlay.

For native Ubuntu/Linux servers, use one of these two modes:
- `dokploy` if TLS and routing are handled by your platform
- `server` if you want the bundled Nginx overlay in the same stack

### Option A: PaaS (Dokploy / Coolify / Traefik)

For platforms that provide their own reverse proxy with automatic TLS:

```bash
cd packages/indexer
./scripts/compose.sh dokploy up -d
```

The platform proxy handles SSL certificates, routing, and HTTPS redirection. Route traffic to the indexer service on internal port `3050`. The container healthcheck uses the internal `/live` probe on `HEALTH_PORT` when available.

### Option B: Standalone with Nginx

For bare-metal or VPS deployments without a PaaS proxy:

```bash
cd packages/indexer
./scripts/compose.sh server up -d
```

This adds an Nginx reverse proxy container that provides:
- **Gzip compression** for JSON responses
- **Rate limiting** at infrastructure level (30 req/s API, 2 req/s multisig)
- **Request buffering** to protect the indexer from slow clients
- **Security headers** (X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
- **Health endpoint** on port `8081` (separate from public traffic)

With this mode, only Nginx is published to the host. PostgreSQL and the indexer stay private inside the Docker network.

#### Enabling TLS

1. Place your certificates in `nginx/ssl/` (or set `SSL_CERT_PATH` in `.env`):
   ```
   nginx/ssl/fullchain.pem
   nginx/ssl/privkey.pem
   ```
2. Uncomment the HTTPS server block in `nginx/nginx.conf`
3. Uncomment the SSL port in `docker-compose.nginx.yml`
4. Restart: `./scripts/compose.sh server up -d`

#### Nginx environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | 80 | HTTP port |
| `PROXY_SSL_PORT` | 443 | HTTPS port (when TLS enabled) |
| `SSL_CERT_PATH` | ./nginx/ssl | Path to SSL certificates |

### Development

For local development, only PostgreSQL runs in Docker:

```bash
cd packages/indexer
./scripts/compose.sh dev up -d
cd ../..
bun run dev:indexer
```

## Security

- **Rate limiting**: 1000 requests/min per IP (CF-Connecting-IP > X-Real-IP > X-Forwarded-For)
- **Multisig rate limiting**: Independent per-buyer and per-IP rate limits for `/api/multisig`
- **Clock drift guard**: Multisig signing is disabled automatically if server time drifts too far from Hive
- **Security headers**: X-Content-Type-Options, Referrer-Policy, Cache-Control
- **Query hard caps**: Max 1000 rows per query regardless of client input
- **Swagger**: Disabled when `NODE_ENV=production`
- **Sync gating**: Data endpoints return 503 until indexer is synced
- **Parametrized queries**: All SQL queries use tagged templates (anti-SQLi)

## Architecture

### Monolith Mode (`INDEXER_ROLE=both`)

The API runs on the main thread with a free event loop. The sync engine runs on a dedicated Bun Worker thread, communicating progress via `postMessage`.

```
Main Thread (event loop free for API)
  |
  +-- Elysia API Server (:3050)
  |     GET /api/nfts, /api/collections, /api/marketplace, ...
  |     Swagger UI (:3050/swagger)
  |     Rate limiting, cache headers, sync gating
  |
  +-- Internal Health Endpoints (:healthPort)
  |     GET /live  -> Docker/Kubernetes liveness probe
  |     GET /ready -> strict readiness probe
  |
  +-- Worker.onmessage <-- receives progress from sync worker
        updateSyncProgress(), setSynced()

Sync Worker Thread (dedicated, never blocks API)
  |
  +-- syncLoop()
  |     |
  |     +-- HafAH REST (fetch + AbortSignal.timeout)
  |     |     Fetches custom_json ops, paginated
  |     |     Endpoint failover with rotation
  |     |
  |     +-- parseHafAHOperations (CPU, ~35ms max)
  |     |
  |     +-- Promise.all(buy enrichment)
  |     |     Parallel RPC calls for payment verification
  |     |
  |     +-- withTransaction(routeOperation x N)
  |     |     25 handlers, infallible routing
  |     |
  |     +-- setTimeout(0) yield (massive sync only)
  |
  +-- postMessage --> main thread
        { type: "progress", lastBlock, headBlock }
```

### Separated Mode

For production at scale, run sync and API as separate processes:

```bash
# Process 1: Sync engine only (writes to DB)
INDEXER_ROLE=sync bun run start

# Process 2: API server only (reads from DB, polls sync_state every 2s)
INDEXER_ROLE=api bun run start
```

Sync instances use `pg_advisory_lock` to prevent double-processing of the same block range when multiple sync processes run against the same database.

### Component Overview

```
Hive Blockchain
    |
    v
+-------------------+
|  Scanner          |  HafAH REST + JSON-RPC with failover
|  (hive-client)    |  AbortSignal.timeout, DNS prefetch
|  (op-parser)      |  Filters custom_json, validates protocol
|  (sync-engine)    |  Batch loop, Promise.all enrichment
|  (sync-worker)    |  Dedicated Bun Worker thread
|  (sync-messages)  |  Typed postMessage (uses Bun fast path)
+--------+----------+
         |
         v
+-------------------+
|  Processor        |  Validates operations
|  (action-router)  |  Infallible: errors -> invalid_operations
|  handlers/        |  core/ marketplace/ allowances/ lending/
+--------+----------+
         |
         v
+-------------------+
|  PostgreSQL       |  Auto-reconnect with exponential backoff
|  (postgres.js)    |  keep_alive: 60s, max_lifetime: 30min
|                   |  collections, nfts, nft_loans, sales,
|                   |  schema_versions, owner_nft_counts, invalid_operations, sync_state,
|                   |  multisig_locks, orphaned_buys
+--------+----------+
         |
         v
+-------------------+
|  REST API         |  Elysia + OpenAPI/Swagger
|  (routes/)        |  Rate limiting, cache headers, health check
|  (multisig)       |  Co-signs buy transactions with node active key
+-------------------+
```

## Protocol Actions (18)

### Core (8)
| Action | Description |
|--------|-------------|
| `create_collection` | Create NFT collection |
| `mint` | Mint seed NFT |
| `bulk_distribute` | Create instances from seed |
| `transfer` | Transfer ownership |
| `replicate` | Create replica |
| `set_data` | Update mutable data (creator only) |
| `archive_collection` | Archive an empty collection |
| `extend_schema` | Add fields to collection schema |

### Marketplace (3)
| Action | Description |
|--------|-------------|
| `list` | List on marketplace |
| `unlist` | Remove listing |
| `buy` | Purchase listed NFT (multisig with node co-signature) |

### Allowances (3)
| Action | Description |
|--------|-------------|
| `nft_approve` | Approve spender for single NFT |
| `nft_approve_all` | Approve spender for entire collection |
| `nft_transfer_from` | Transfer NFT as approved spender |

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

## Code Architecture

### Pure Business Logic (zero I/O, testable with plain values)

All business rules are extracted as pure functions in two utility modules:

**`utils/nft-rules.ts`** — NFT domain rules:
| Function | Purpose |
|----------|---------|
| `resolveNftType` | Determine seed vs instance from ID pattern |
| `validateSeedCap` | Enforce collection seed limit |
| `validateTransferCount` | Reject extra transfers in buy payment |
| `computeInstanceBaseline` | Replay-safe instance numbering |
| `validateSeedSupplyForDistribution` | Check seed supply before minting |

**`utils/data-transforms.ts`** — Data validation and transformation:
| Function | Purpose |
|----------|---------|
| `formatSchemaErrors` | Consistent error formatting (used by 6 handlers) |
| `validateAndMergeMutableData` | Schema validate + shallow merge + hash (used by set_data and set_data_from) |

### Handler Pattern

Each handler follows the same structure: parse input -> validate (pure) -> read state (DB) -> check rules (pure) -> write state (DB).

```
handleMint(op, txn)
  |-- requireString(op.data.id)           -- pure: parse input
  |-- resolveNftType(type, id)            -- pure: business rule
  |-- validateSeedCap(id, count, cap)     -- pure: business rule
  |-- formatSchemaErrors(errors)          -- pure: data transform
  |-- insertNft(...)                      -- I/O: DB write
```

### Infallible Operation Router

The action router (`processor/action-router.ts`) uses a `Record<string, Handler>` dispatcher. Every handler call is wrapped in try/catch — errors are logged to `invalid_operations` and never abort the sync loop.

## Reliability

### Event Loop Protection

The sync engine never blocks the API server:
- **Worker thread isolation**: Sync runs on a dedicated Bun Worker (monolith mode)
- **Event loop yields**: `setTimeout(0)` between batches during massive sync
- **Parallel enrichment**: Buy transfer lookups use `Promise.all`
- **CPU-bound parsing**: ~35ms max per batch, well within acceptable limits

### Database Resilience

PostgreSQL connection pool (postgres.js) with production hardening:
- **Auto-reconnect**: Exponential backoff (0.5s -> 20s max) on connection loss
- **TCP keep-alive**: Ping every 60s to detect dead connections before they timeout
- **Connection recycling**: `max_lifetime: 30min` prevents prepared statement bloat
- **Idle cleanup**: Connections idle >30s are released back to the OS
- **onclose logging**: Every connection drop is logged for observability

### Hive Endpoint Failover

- **Multi-endpoint rotation**: Cycles through configured endpoints on failure
- **AbortSignal.timeout**: All fetch calls have hard timeouts (15s normal, 45s massive)
- **DNS prefetch**: Endpoints pre-resolved at startup via `dns.prefetch()`
- **Response body drain**: Error responses consumed to prevent connection leaks
- **Adaptive page sizes**: 1000 ops/page normal, 5000 ops/page during catch-up

### Error Handling

- **Infallible operation routing**: Handler errors recorded in `invalid_operations`, never abort sync
- **Orphaned buy detection**: Failed buy ops with HIVE transfers flagged for manual review
- **Block continuity checks**: In-memory cursor verified against DB each batch (max 3 failures)
- **Global error handlers**: `unhandledRejection` and `uncaughtException` prevent silent death

### Production Environment Variables

| Variable | Recommended | Purpose |
|----------|-------------|---------|
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | 512 | Increase concurrent fetch limit for massive sync |
| `BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS` | 5 | Faster DNS failover for Hive endpoints |
| `DO_NOT_TRACK` | 1 | Disable Bun telemetry |

## Testing

```bash
# All tests (38 tests across 4 files)
bun test

# Unit tests only
bun test src/__tests__/sync-engine.test.ts src/__tests__/sync-state.test.ts

# Concurrency tests (event loop yields, parallel enrichment, progress tracking)
bun test src/__tests__/concurrency.test.ts

# Stress tests (4800 HTTP requests, API under sync load, GC pressure)
bun test src/__tests__/stress.test.ts

# Integration tests (handlers with real DB)
bun test src/__tests__/handlers.test.ts
```

### Test Coverage

| Suite | Tests | What it verifies |
|-------|-------|-----------------|
| sync-engine | 11 | Block processing, continuity, massive sync, genesis init |
| sync-state | 8 | State management, SyncReporter for worker mode |
| concurrency | 12 | Event loop yields, buy parallelism, progress accuracy |
| stress | 7 | 4800 HTTP requests, API during sync, GC stability |
| handlers | 63 | All 25 operation handlers with real PostgreSQL |

## License

MIT

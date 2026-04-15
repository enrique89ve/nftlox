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

**SPV Verification ("Boleto Suizo")** -- The client doesn't trust the indexer blindly. For ownership, the indexer returns a compact current-owner claim (`owner`, `previous_owner`, `owner_action`, `owner_operation_id`, `owner_block_num`, `claim_hash`), and the SDK resolves `owner_operation_id` directly through HAFAH/Hive L1 before accepting it. PostgreSQL stays a fast projection; Hive L1 remains the authority.

```
Client                         Indexer              Hive L1
  |--- GET /api/nfts/:id/ownership ->|                   |
  |<-- owner claim + op id -------|                      |
  |--- resolve owner_operation_id --------------------->|
  |<-- raw transaction ----------|------- HAFAH --------|
  |                                                     |
  [derive owner from custom_json]                       |
  [compare L1-derived owner with claim fields]          |
  -> match? ownership is verified                       |
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
| `GET /api/nfts/:id/owner` | Fast current-owner claim (`owner`, operation anchor, block, claim hash) |
| `GET /api/nfts/:id/ownership` | Canonical ownership proof for SDK/HafAH verification |
| `GET /api/nfts/:id/proof` | Compatibility alias for the ownership proof contract |
| `GET /api/nfts/:id/loan` | Active loan custody for this NFT, separate from ownership |
| `GET /api/nfts/:id/instances` | Instances distributed from this seed |

### Users
| Endpoint | Description |
|----------|-------------|
| `GET /api/users/:username/assets` | Dashboard overview of owned NFTs, seeds, loans, and collections |
| `GET /api/users/:username/nfts` | User's NFTs with counts (?status=active&type=seed) |
| `GET /api/users/:username/nfts/count` | NFT counts by type (seeds, instances) |
| `GET /api/users/:username/loans` | Active loans by role (?role=lender\|borrower\|all) |
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
- `royalty_pct` in collection responses remains a whole percent for protocol `0.5.x`.
- Monetary fields such as `listing_price`, `gross_amount`, `royalty_amount`, `protocol_fee`, `seller_net`, `totalPrice`, `sellerAmount`, `royaltyAmount`, and `feeAmount` are Hive asset amounts with 3 decimal places.
- `multisigClockDriftMs` and rate-limit windows are expressed in milliseconds.
- `lastBlock`, `headBlock`, `irreversibleBlock`, and `genesisBlock` are Hive block numbers.
- `owner_operation_id` is the authoritative ownership anchor resolved through HAFAH/Hive L1. `owner_block_num` is useful context and ordering metadata, but not unique proof by itself because a block can contain multiple ownership operations.
- `claim_hash` is a deterministic hash over the compact owner claim fields. L1 verification still depends on resolving `owner_operation_id`.
- `confirmed_operations.nft_ids` is bounded by design. Bulk creation operations such as `bulk_distribute` may store an empty NFT ID list because each NFT row already stores its own creation and owner anchors.

## Self-Hosting

### 1. Choose your database

The indexer needs PostgreSQL 14+. You can let Docker manage it or bring your own.

```
+---------------------------+       +---------------------------+
|  Option A (default)       |       |  Option B                 |
|  Docker manages Postgres  |       |  Bring your own Postgres  |
|                           |       |                           |
|  .env:                    |       |  .env:                    |
|  POSTGRES_PASSWORD=secret |       |  DATABASE_URL=postgres:// |
|                           |       |    user:pass@host/db      |
|  That's it.               |       |  POSTGRES_PASSWORD=pass   |
+---------------------------+       +---------------------------+
```

### 2. Configure

```bash
cd packages/indexer
cp .env.example .env
```

Open `.env` and set **one required variable**:

```bash
# Required — no default in production
POSTGRES_PASSWORD=your_secure_password
```

Everything else has sensible defaults. The genesis block, Hive endpoints, batch size, and all other settings are pre-configured. See `.env.example` for the full list of optional overrides.

**Want marketplace buy/sell?** Add these three:

```bash
HIVE_ACCOUNT=your-node-account
ACTIVE_KEY=5J...your-active-key
BEEKEEPER_PASSWORD=your-wallet-password
```

Without them the indexer still syncs and serves the full read API. Only the multisig co-signing endpoint is disabled.

### 3. Deploy

Pick the deployment mode that fits your infrastructure:

#### PaaS (Dokploy / Coolify / Traefik)

Your platform handles TLS and routing. One command:

```bash
./scripts/compose.sh dokploy up -d
```

Route traffic to the indexer on internal port `3050`.

#### VPS with bundled Nginx

Includes a reverse proxy with rate limiting, gzip, and security headers:

```bash
./scripts/compose.sh server up -d
```

Only Nginx is published to the host (port 80). PostgreSQL and the indexer stay private inside the Docker network.

<details>
<summary>Enable TLS</summary>

1. Place your certificates:
   ```
   nginx/ssl/fullchain.pem
   nginx/ssl/privkey.pem
   ```
2. Uncomment the HTTPS server block in `nginx/nginx.conf`
3. Uncomment the SSL port in `docker-compose.nginx.yml`
4. `./scripts/compose.sh server up -d`
</details>

#### External PostgreSQL (RDS, Supabase, managed DB)

Set `DATABASE_URL` in your `.env` and start only the indexer:

```bash
# .env
DATABASE_URL=postgres://user:password@your-host:5432/nftlox_indexer
POSTGRES_PASSWORD=your_password
```

```bash
docker compose -f docker-compose.yml up -d indexer
```

The indexer runs schema migrations automatically on startup (`CREATE TABLE IF NOT EXISTS`). It never drops or alters existing columns.

### 4. Verify

```bash
# Check sync status
curl http://localhost:3050/api/status

# Check health
curl http://localhost:3050/api/health

# View logs
docker compose logs -f indexer
```

The indexer is ready when `blocksBehind` reaches `0` in `/api/status`.

### Updating

```bash
git pull
./scripts/compose.sh dokploy up -d --build
```

The indexer picks up schema changes on restart. No manual migrations needed.

## Docker Hardening

The production compose includes these protections out of the box:

| Feature | Purpose |
|---------|---------|
| `restart: always` | Auto-restart after crashes or host reboots |
| `init: true` | Prevents zombie process accumulation (tini as PID 1) |
| `stop_grace_period: 30s` | Graceful shutdown for in-flight transactions |
| `read_only: true` | Immutable container filesystem |
| `tmpfs /tmp` | Writable scratch space in RAM only |
| `shm_size: 256m` | Prevents Postgres shared memory errors under load |
| Memory and CPU limits | Prevents container starvation |
| `json-file` logging with rotation | Prevents disk exhaustion from logs |
| Non-root user (`bun`) | Reduced attack surface inside containers |
| OCI labels | Image traceability (commit SHA, build time, branch) |

The sync worker auto-restarts on crash with exponential backoff (1s, 2s, 4s... up to 30s, max 10 retries per minute). If it exhausts retries, the API continues serving cached state and logs an error requiring manual intervention.

Beekeeper (multisig key storage) runs entirely in WASM memory (`inMemory: true`). Keys are never written to disk, not even inside the container.

## Configuration Reference

All variables are optional except `POSTGRES_PASSWORD`. The indexer uses protocol constants and sensible defaults when a variable is not set.

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | **required** | PostgreSQL password |
| `DATABASE_URL` | auto-built by compose | Full connection string. Set this to use an external database |
| `POSTGRES_DB` | `nftlox_indexer` | Database name |
| `POSTGRES_USER` | `nftlox` | Database user |

### Multisig

| Variable | Default | Description |
|----------|---------|-------------|
| `ACTIVE_KEY` | (disabled) | Node's Hive active key (WIF) |
| `BEEKEEPER_PASSWORD` | (disabled) | In-memory beekeeper wallet password |
| `HIVE_ACCOUNT` | `nftlox` | Account that signs buy ops and receives protocol fee |

### Sync Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `GENESIS_BLOCK` | `105530500` | Protocol genesis block. Override only for partial re-indexes |
| `ALLOW_UNSAFE_GENESIS_BLOCK` | `false` | Allow starting after the canonical genesis block |
| `BATCH_SIZE` | `1000` | Blocks per sync request |
| `SYNC_INTERVAL_MS` | `3000` | Polling interval when caught up (ms) |
| `HIVE_ENDPOINTS` | syncad, mahdiyari, hive.blog | Comma-separated Hive API endpoints (must support HafAH) |
| `INDEXER_ROLE` | `both` | `sync` (write only), `api` (read only), or `both` |

### API & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | `3050` | REST API port |
| `ALLOWED_ORIGINS` | (all origins) | Comma-separated CORS allowlist. Set this in production |
| `ENABLE_SWAGGER` | auto | `true` in dev, `false` in production |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_URL` | (empty) | Public URL of this node (informational) |
| `HEALTH_PORT` | `0` (disabled) | Separate internal port for `/live` and `/ready` probes |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `MULTISIG_RATE_LIMIT_MAX` | `10` | Max multisig requests per buyer per window |
| `MULTISIG_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `MULTISIG_IP_RATE_LIMIT_MAX` | `30` | Max multisig requests per IP per window |
| `MULTISIG_IP_RATE_LIMIT_WINDOW_MS` | `60000` | Per-IP rate limit window (ms) |

### Nginx (only with `./scripts/compose.sh server`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `80` | HTTP port |
| `PROXY_SSL_PORT` | `443` | HTTPS port (when TLS enabled) |
| `SSL_CERT_PATH` | `./nginx/ssl` | Path to SSL certificates |

### Bun Runtime

| Variable | Recommended | Description |
|----------|-------------|-------------|
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | `512` | Increase concurrent fetch limit for massive sync |
| `BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS` | `5` | Faster DNS failover for Hive endpoints |
| `DO_NOT_TRACK` | `1` | Disable Bun telemetry |

## Operational Scripts

| Script | Purpose |
|--------|---------|
| `scripts/compose.sh <mode>` | Resolves compose files for `dokploy`, `server`, or `dev` |
| `scripts/build-image.sh [tag]` | Builds the indexer image with OCI labels (commit, branch, timestamp) |
| `scripts/docker-entrypoint.sh` | Container entrypoint: dispatches `start`, `sync`, `api`, or `monolith` |
| `scripts/docker-healthcheck.sh` | Health probe: `/live` on `HEALTH_PORT` or fallback to `/api/health` |
| `scripts/dev-env.sh` | Detects WSL, slow `/mnt/*` paths, missing `buildx` |

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
| `set_data` | Update mutable data (creator only) |
| `archive_collection` | Archive an empty collection |
| `extend_schema` | Add fields to collection schema |
| `node_register` | Register/update an indexer node record |

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

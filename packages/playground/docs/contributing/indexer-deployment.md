# Indexer deployment

Deployment paths for the NFTLox indexer (`packages/indexer`). Each path is self-contained — pick the one that matches your environment.

## Prerequisites

- [Bun](https://bun.sh) v1.1+ (required runtime — uses io_uring for async I/O)
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL and/or full containerized deployment)

## 1. Choose your database

The indexer needs PostgreSQL 14+. You can let Docker manage it or bring your own.

```
+---------------------------+       +---------------------------+
|  Option A (default)       |       |  Option B                 |
|  Docker manages Postgres  |       |  Bring your own Postgres  |
|                           |       |                           |
|  .env:                    |       |  .env:                    |
|  POSTGRES_PASSWORD=secret |       |  DATABASE_URL=postgres:// |
|  DATABASE_MODE=internal   |       |  DATABASE_MODE=external   |
|                           |       |    user:pass@host/db      |
|  That's it.               |       |  That's it.               |
+---------------------------+       +---------------------------+
```

## 2. Configure

```bash
cd packages/indexer
cp .env.example .env
```

Open `.env` and set the variables for your chosen topology:

```bash
# Internal PostgreSQL (default)
DATABASE_MODE=internal
POSTGRES_PASSWORD=your_secure_password
```

```bash
# External PostgreSQL
DATABASE_MODE=external
DATABASE_URL=postgres://user:password@your-host:5432/nftlox_indexer
```

Everything else has sensible defaults. The genesis block, Hive endpoints, batch size, and all other settings are pre-configured. See `.env.example` for the full list of optional overrides.

**Want marketplace buy/sell?** Add these three:

```bash
HIVE_ACCOUNT=your-node-account
ACTIVE_KEY=5J...your-active-key
BEEKEEPER_PASSWORD=your-wallet-password
```

Without them the indexer still syncs and serves the full read API. Only the multisig co-signing endpoint is disabled.

## 3. Deploy

Pick the deployment mode that fits your infrastructure.

### Local development with Docker Compose

Only PostgreSQL runs in Docker; the indexer runs on the host with Bun:

```bash
cd packages/indexer
./scripts/compose.sh dev up -d
cd ../..
bun run dev:indexer
```

### Behind an external proxy (Dokploy, Coolify, Traefik)

Your platform handles TLS and routing. One compose file, one command:

```bash
cd packages/indexer
./scripts/compose.sh dokploy up -d
```

Route traffic to the indexer on internal port `3050`.

### VPS with bundled Nginx overlay

Includes a reverse proxy with rate limiting, gzip, and security headers:

```bash
cd packages/indexer
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
3. Uncomment the SSL port in `docker-compose.yml`
4. `./scripts/compose.sh server up -d`
</details>

### Cloudflare proxy

If your DNS record is orange-clouded behind Cloudflare, keep the topology as:

```text
Client -> Cloudflare -> nginx -> indexer
```

The bundled `nginx` is prepared for Cloudflare's `CF-Connecting-IP` header and
trusts only Cloudflare's published proxy ranges for real-IP restoration. This
keeps rate limiting and logs keyed to the original visitor IP instead of the
Cloudflare edge IP.

Recommended production setup:

1. Use `./scripts/compose.sh server up -d`
2. In Cloudflare SSL/TLS, use `Full (strict)` instead of `Flexible`
3. Restrict origin access so only Cloudflare IP ranges can reach ports `80/443`
4. Keep `packages/indexer/nginx/cloudflare-realip.conf` updated when Cloudflare publishes new ranges

### External PostgreSQL (RDS, Supabase, managed DB)

Set `DATABASE_MODE=external` and `DATABASE_URL` in your `.env`, then start the
same production compose:

```bash
# .env
DATABASE_MODE=external
DATABASE_URL=postgres://user:password@your-host:5432/nftlox_indexer
```

```bash
./scripts/compose.sh dokploy up -d
```

The indexer runs schema migrations automatically on startup (`CREATE TABLE IF NOT EXISTS`). It never drops or alters existing columns.

### Building the image directly

```bash
cd packages/indexer
./scripts/build-image.sh nftlox-indexer
```

If Docker bridge networking is flaky on your machine:

```bash
DOCKER_BUILD_NETWORK=host ./scripts/build-image.sh nftlox-indexer
```

## 4. Verify

```bash
curl http://localhost:3050/api/status
curl http://localhost:3050/api/health
docker compose logs -f indexer
```

The indexer is ready when `blocksBehind` reaches `0` in `/api/status`.

## Updating

```bash
git pull
./scripts/compose.sh dokploy up -d --build
```

The indexer picks up schema changes on restart. No manual migrations needed.

## Architecture modes

### Monolith mode (`INDEXER_ROLE=both`)

The API runs on the main thread with a free event loop. The sync engine runs on a dedicated Bun Worker thread, communicating progress via `postMessage`.

### Separated mode

For production at scale, run sync and API as separate processes:

```bash
# Process 1: Sync engine only (writes to DB)
INDEXER_ROLE=sync bun run start

# Process 2: API server only (reads from DB, polls sync_state every 2s)
INDEXER_ROLE=api bun run start
```

Sync instances use `pg_advisory_lock` to prevent double-processing of the same block range.

## Docker hardening

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

## Security

- **Rate limiting**: 1000 requests/min per IP (CF-Connecting-IP > X-Real-IP > X-Forwarded-For)
- **Multisig rate limiting**: Independent per-buyer/creator and per-IP rate limits for `/api/multisig/buy` and `/api/multisig/collection`
- **Clock drift guard**: Multisig signing is disabled automatically if server time drifts too far from Hive
- **Security headers**: X-Content-Type-Options, Referrer-Policy, Cache-Control
- **Query hard caps**: Max 1000 rows per query regardless of client input
- **Swagger**: Disabled when `NODE_ENV=production`
- **Sync gating**: Data endpoints return 503 until indexer is synced
- **Parametrized queries**: All SQL queries use tagged templates (anti-SQLi)

## Reliability

### Event loop protection

- **Worker thread isolation**: Sync runs on a dedicated Bun Worker (monolith mode)
- **Event loop yields**: `setTimeout(0)` between batches during massive sync
- **Parallel enrichment**: Buy transfer lookups use `Promise.all`

### Database resilience

PostgreSQL connection pool (postgres.js) with production hardening:
- **Auto-reconnect**: Exponential backoff (0.5s -> 20s max) on connection loss
- **TCP keep-alive**: Ping every 60s to detect dead connections before they timeout
- **Connection recycling**: `max_lifetime: 30min` prevents prepared statement bloat

### Hive endpoint failover

- **Multi-endpoint rotation**: Cycles through configured endpoints on failure
- **AbortSignal.timeout**: All fetch calls have hard timeouts (15s normal, 45s massive)
- **DNS prefetch**: Endpoints pre-resolved at startup via `dns.prefetch()`

### Error handling

- **Infallible operation routing**: Handler errors recorded in `invalid_operations`, never abort sync
- **Orphaned buy detection**: Failed buy ops with HIVE transfers flagged for manual review
- **Block continuity checks**: In-memory cursor verified against DB each batch

## Configuration reference

The indexer uses protocol constants and sensible defaults when a variable is not set. Internal DB deployments require `POSTGRES_PASSWORD`; external DB deployments require `DATABASE_MODE=external` plus `DATABASE_URL`.

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | internal DB only | PostgreSQL password for the bundled service |
| `DATABASE_MODE` | `auto` | `internal`, `external`, or `auto` DB resolution |
| `DATABASE_URL` | unset | Full connection string. Required when `DATABASE_MODE=external` |
| `POSTGRES_DB` | `nftlox_indexer` | Database name |
| `POSTGRES_USER` | `nftlox` | Database user |
| `POSTGRES_HOST` | `postgres` in Docker, `localhost` in host-run dev | Database host for internal mode |

### Multisig

| Variable | Default | Description |
|----------|---------|-------------|
| `ACTIVE_KEY` | (disabled) | Node's Hive active key (WIF) |
| `BEEKEEPER_PASSWORD` | (disabled) | In-memory beekeeper wallet password |
| `HIVE_ACCOUNT` | `nftlox` | Account that signs buy ops and receives protocol fee |

### Sync engine

| Variable | Default | Description |
|----------|---------|-------------|
| `BATCH_SIZE` | `1000` | Blocks per sync request |
| `SYNC_INTERVAL_MS` | `3000` | Polling interval when caught up (ms) |
| `HIVE_ENDPOINTS` | syncad, mahdiyari, hive.blog | Comma-separated Hive API endpoints (must support HafAH) |
| `INDEXER_ROLE` | `both` | `sync` (write only), `api` (read only), or `both` |

### API and security

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | `3050` | REST API port |
| `ALLOWED_ORIGINS` | (all origins) | Comma-separated CORS allowlist. Set this in production |
| `ENABLE_SWAGGER` | auto | `true` in dev, `false` in production |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_URL` | (empty) | Public URL of this node (informational) |
| `HEALTH_PORT` | `0` (disabled) | Separate internal port for `/live` and `/ready` probes |

### Rate limiting

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

### Bun runtime

| Variable | Recommended | Description |
|----------|-------------|-------------|
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | `512` | Increase concurrent fetch limit for massive sync |
| `BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS` | `5` | Faster DNS failover for Hive endpoints |
| `DO_NOT_TRACK` | `1` | Disable Bun telemetry |

## Operational scripts

| Script | Purpose |
|--------|---------|
| `scripts/compose.sh <mode>` | Resolves compose files for `dokploy`, `server`, or `dev` |
| `scripts/build-image.sh [tag]` | Builds the indexer image with OCI labels (commit, branch, timestamp) |
| `scripts/docker-entrypoint.sh` | Container entrypoint: dispatches `start`, `sync`, `api`, or `monolith` |
| `scripts/docker-healthcheck.sh` | Health probe: `/live` on `HEALTH_PORT` or fallback to `/api/health` |
| `scripts/dev-env.sh` | Detects WSL, slow `/mnt/*` paths, missing `buildx` |

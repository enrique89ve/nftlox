# @nftlox/indexer

> NFTLox blockchain scanner — streams Hive L1 operations into PostgreSQL and exposes a REST API + Swagger.

**Default port:** 3050

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL)

## Quick start (development)

```bash
cd packages/indexer
cp .env.example .env
./scripts/compose.sh dev up -d   # PostgreSQL via Docker
cd ../..
bun run dev:indexer
```

The Swagger UI is at <http://localhost:3050/swagger>.

## Key environment variables

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | **required** | PostgreSQL password |
| `DATABASE_URL` | auto-built | Full connection string (set to use external DB) |
| `HIVE_ACCOUNT` | `nftlox` | Node account for multisig co-signing |
| `ACTIVE_KEY` | (disabled) | Hive active key (enables marketplace buy/sell) |
| `BEEKEEPER_PASSWORD` | (disabled) | In-memory beekeeper wallet password |
| `BATCH_SIZE` | `1000` | Blocks per sync request |
| `INDEXER_PORT` | `3050` | REST API port |
| `INDEXER_ROLE` | `both` | `sync`, `api`, or `both` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Full configuration reference in the [deployment guide](../playground/docs/contributing/indexer-deployment.md).

## How it works

The indexer reads Hive L1 block by block, validates NFTLox `custom_json` operations, and projects state into PostgreSQL. This gives you SQL joins, sorting, filtering, and pagination over millions of NFTs — things impossible when querying raw blockchain JSON.

**Multisig buy** — marketplace purchases use a co-signing flow. The buyer builds a transaction with HIVE transfers (seller + royalty + fee) and a `buy` operation. The indexer validates the payment split and co-signs. Both signatures are required, so funds only move if the NFT transfer also happens.

**Lending** — NFTs can be lent without transferring ownership. The protocol blocks transfers, sales, and burns while lent.

**Data operators** — a game can write stats to NFTs it didn't create. The collection creator approves an operator once; that operator can then call `set_data_from` on any NFT in the collection.

**SPV verification ("Boleto Suizo")** — the client doesn't trust the indexer blindly. For ownership, the indexer returns a compact current-owner claim with `owner_operation_id`, and the SDK resolves it directly through HAFAH/Hive L1. PostgreSQL is a fast projection; Hive L1 remains the authority.

## REST API

Interactive documentation at `http://localhost:3050/swagger` (disabled in production).

### Status and health
| Endpoint | Description |
|---|---|
| `GET /api/status` | Sync progress (lastBlock, headBlock, blocksBehind, multisigEnabled) |
| `GET /api/health` | Combined liveness + readiness |
| `GET /api/stats` | Protocol totals (collections, NFTs, listed, burned) |
| `GET /api/state-root` | Incremental XOR commitment for cross-indexer verification |

### Collections
| Endpoint | Description |
|---|---|
| `GET /api/collections` | List all (?limit, ?offset) |
| `GET /api/collections/:id` | Collection details |
| `GET /api/collections/:id/nfts` | NFTs in collection (?type=seed) |
| `GET /api/collections/:id/stats` | Aggregated statistics |
| `GET /api/collections/:id/schema-history` | Schema version history (hash chain) |

### NFTs
| Endpoint | Description |
|---|---|
| `GET /api/nfts?ids=a,b,c` | Batch read up to 200 NFTs |
| `GET /api/nfts/:id` | NFT details |
| `GET /api/nfts/:id/owner` | Fast current-owner claim |
| `GET /api/nfts/:id/ownership` | Canonical ownership proof for SPV verification |
| `GET /api/nfts/:id/proof` | Compatibility alias for ownership proof |
| `GET /api/nfts/:id/loan` | Active loan custody |
| `GET /api/nfts/:id/instances` | Instances distributed from this seed |

### Users
| Endpoint | Description |
|---|---|
| `GET /api/users/:username/assets` | Dashboard overview (NFTs, seeds, loans, collections) |
| `GET /api/users/:username/nfts` | User's NFTs with counts |
| `GET /api/users/:username/nfts/count` | NFT counts by type |
| `GET /api/users/:username/loans` | Active loans by role |
| `GET /api/users/:username/collections` | User's collections |

### Marketplace
| Endpoint | Description |
|---|---|
| `GET /api/marketplace/listings` | Active listings (?sort=price_asc&currency=HIVE) |
| `GET /api/marketplace/sales` | Completed sales with financial breakdown |
| `GET /api/marketplace/volume` | Aggregated marketplace volume statistics |

### Multisig
| Endpoint | Description |
|---|---|
| `GET /api/payment-info/:nftId` | Payment split for building a buy transaction |
| `POST /api/multisig` | Validate and co-sign a buy transaction |

All list endpoints support `?limit=N&offset=N`.

### SPV provenance contract

Every NFT-returning endpoint includes fields for trustless ownership verification:

| Field | Meaning |
|---|---|
| `owner` | Current owner account |
| `previous_owner` | Account that held the NFT before the latest change (`null` at mint) |
| `owner_action` | Protocol action that last changed ownership (`mint`, `bulk_distribute`, `transfer`, `nft_transfer_from`, `buy`) |
| `owner_operation_id` | HafAH operation id of that action — the authoritative anchor |
| `owner_block_num` | Block in which the action landed |
| `claim_hash` | Deterministic hash over the compact owner claim fields |

### Public API units

- `protocolFeeBps` / `maxRoyaltyBps` in `GET /api/status` use basis points (`100 = 1%`, `5000 = 50%`).
- Monetary fields (`listing_price`, `gross_amount`, `royalty_amount`, `protocol_fee`, `seller_net`) are Hive asset amounts with 3 decimal places.
- `multisigClockDriftMs` and rate-limit windows are expressed in milliseconds.
- `lastBlock`, `headBlock`, `irreversibleBlock`, `genesisBlock` are Hive block numbers.

## Protocol actions (19)

| Category | Actions |
|---|---|
| **Core (9)** | `create_collection`, `mint`, `bulk_distribute`, `transfer`, `set_data`, `extend_schema`, `archive_collection`, `node_register`, `node_heartbeat` |
| **Marketplace (3)** | `list`, `unlist`, `buy` |
| **Allowances (3)** | `nft_approve`, `nft_approve_all`, `nft_transfer_from` |
| **Lending (2)** | `nft_lend`, `nft_return` |
| **Data operators (2)** | `data_operator_approve`, `set_data_from` |

## Deployment

For Docker, Compose, Dokploy, Nginx, build-image, architecture modes, Docker hardening, full env var reference, and VPS recipes, see the [deployment guide](../playground/docs/contributing/indexer-deployment.md).

## Documentation

- [API Endpoints reference](../playground/docs/api-endpoints.md)
- [Database Migration Strategy](../playground/docs/contributing/database-migrations.md)
- [Development Guide](../playground/docs/contributing/development-guide.md)

## Scripts

| Script | Description |
|---|---|
| `bun run dev` | Start the indexer in development mode |
| `bun run start` | Start the indexer in production mode |
| `bun run test` | Run all indexer tests (uses `scripts/test.sh` for isolation) |

## Testing

```bash
bun test
```

| Suite | Tests | What it verifies |
|---|---|---|
| sync-engine | 11 | Block processing, continuity, massive sync, genesis init |
| sync-state | 8 | State management, SyncReporter for worker mode |
| concurrency | 12 | Event loop yields, buy parallelism, progress accuracy |
| stress | 7 | 4800 HTTP requests, API during sync, GC stability |
| handlers | 63 | All 25 operation handlers with real PostgreSQL |

## License

MIT

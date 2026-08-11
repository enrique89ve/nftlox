# @nftlox/indexer

Hive scanner and deterministic state projection for NFTLox. The indexer reads
Hive L1 operations, validates them against `@nftlox/protocol`, stores the
projection in PostgreSQL, and exposes a REST API.

PostgreSQL is a query projection. Hive remains the authority, and applications
can use the SDK's SPV helpers to verify ownership edges before irreversible
actions.

## Quick start

Prerequisites: Bun 1.1+ and Docker.

```bash
cd packages/indexer
cp .env.example .env
./scripts/compose.sh dev up -d
cd ../..
bun run dev:indexer
```

Swagger is available at <http://localhost:3050/swagger>.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | unset | Use an external PostgreSQL database |
| `DATABASE_MODE` | `auto` | `internal`, `external`, or automatic detection |
| `HIVE_ACCOUNT` | `nftlox` | Node account used by multisig flows |
| `ACTIVE_KEY` | disabled | Enables node-side marketplace settlement |
| `INDEXER_ROLE` | `both` | `sync`, `api`, or both processes |
| `INDEXER_PORT` | `3050` | REST API port |
| `HEALTH_PORT` | disabled | Separate liveness/readiness port |
| `BATCH_SIZE` | `1000` | Blocks per sync request |

See the [deployment guide](../playground/docs/contributing/indexer-deployment.md)
for production configuration, Docker modes, proxies, and database options.

## API

The indexer exposes read endpoints for collections, NFTs, users, marketplace
listings, health, status, and state roots. It also exposes exactly two narrow
multisig endpoints:

- `POST /api/multisig/collection` — co-sign `create_collection`.
- `POST /api/multisig/buy` — settle a buyer-signed node-last `buy`.

The complete contract is in the [API Reference](../playground/docs/reference/api.md).

## Protocol boundary

- The accepted actions and authority map come from
  [`@nftlox/protocol`](../protocol/README.md).
- The signer is derived from Hive operation authorities, not from payload data.
- `bulk_distribute` creates instances from seeds; pack planning is external.
- Peer checkpoint mismatches are advisory because permissionless node accounts
  are not a Sybil-resistant quorum.
- A verified local integrity failure or explicit operator action is a separate
  condition from an untrusted peer mismatch.

## Database management

For the current clean-schema workflow, see
[`DB_MANAGEMENT.md`](./DB_MANAGEMENT.md). Deployment and operational hardening
belong in the [deployment guide](../playground/docs/contributing/indexer-deployment.md).

## Scripts

| Script | Description |
|---|---|
| `bun run dev` | Start the indexer in development mode |
| `bun run start` | Start the indexer in production mode |
| `bun run test` | Run the indexer test suite |

## License

MIT

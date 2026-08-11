# @nftlox/playground

Browser harness for testing NFTLox with Hive Keychain. It also serves the
Docsify documentation site.

## Run locally

Prerequisites: Bun, Docker/PostgreSQL through the indexer, and the Hive
Keychain browser extension.

```bash
bun install
bun run dev:indexer       # in one terminal
bun run dev:playground    # in another terminal
```

Open <http://localhost:3040>. The documentation is at
<http://localhost:3040/docs/>.

## What it demonstrates

The playground exercises the real SDK and protocol flows: collection and seed
creation, `bulk_distribute`, transfers, marketplace settlement, lending,
approvals, mutable data, and SPV verification.

It includes a browser-facing build API for preparing operations, but it does
not replace the SDK or the indexer's public API as documentation sources.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `INDEXER_URL` | `http://localhost:3050` | Indexer API base URL |
| `HIVE_ACCOUNT` | empty | Optional debug signing account |
| `ACTIVE_KEY` | empty | Optional debug signing key |

## Documentation

The canonical public documentation lives in [`docs/`](./docs/). The normative
wire contract lives in [`@nftlox/protocol`](../protocol/README.md).

## Scripts

| Script | Description |
|---|---|
| `bun run dev` | Start the playground in development |
| `bun run start` | Start the playground in production |

## License

MIT

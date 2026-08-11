# @nftlox/indexer-snapshot

> **Status:** Design-only placeholder. No implementation yet — this README describes the service contract so the monorepo slot is reserved and the design is reviewable before any code lands.

Standalone service that polls NFTLox indexer nodes, evaluates their quality, extracts consistent database snapshots, and publishes them (compressed) to IPFS or as PostgreSQL basebackups so new nodes and downstream services can bootstrap without replaying history from `PROTOCOL_GENESIS_BLOCK`.

---

## Why a separate package

The sync engine inside `@nftlox/indexer` has a hard invariant: **it must never be interrupted**. Producing snapshots from a hot indexer database means:

- Long-running `pg_dump` holds MVCC snapshot isolation → VACUUM pressure and table bloat.
- HTTP streaming multi-GB dumps blocks the sync interval budget.
- Backpressure on the indexer pool starves the sync loop.

A separate service with its own lifecycle and its own read source solves all three. It also lets multiple independent operators publish snapshots in parallel — which is the whole point of a decentralized bootstrap.

---

## High-level architecture

```
                Hive L1 (source of truth)
                          │
                          ▼
 ┌──────────────────────────────────────────────────┐
 │  NFTLox indexer nodes (N peers in the wild)      │
 │  each exposes:   /api/state-root, /api/status    │
 └──────────────────────────────────────────────────┘
            │                              │
            │ probe health + state-root    │ logical replication
            ▼                              ▼
 ┌────────────────────┐        ┌─────────────────────────┐
 │  node-scanner      │        │  read-replica of ONE    │
 │  scorer            │        │  trusted peer (or own   │
 │  consensus picker  │        │  indexer DB)            │
 └──────────┬─────────┘        └───────────┬─────────────┘
            │ pick healthy peer            │
            └─────────────┬────────────────┘
                          ▼
                ┌──────────────────────┐
                │  snapshot-publisher  │
                │  pg_dump -Fc | zstd  │
                └──────────┬───────────┘
                           │ upload
          ┌────────────────┼─────────────────┐
          ▼                ▼                 ▼
 ┌────────────────┐ ┌──────────────┐ ┌───────────────┐
 │  IPFS (CID)    │ │  S3 / R2     │ │  pg basebackup│
 │  content-      │ │  any HTTPS   │ │  + WAL archive│
 │  addressed     │ │  CDN         │ │  for replicas │
 └────────┬───────┘ └──────┬───────┘ └────────┬──────┘
          └─────────┬──────┴──────────────────┘
                    ▼
       ┌─────────────────────────────┐
       │  signed manifest            │
       │  { at_block, state_root,    │
       │    sha256, size, url(s),    │
       │    schema_version }         │
       │  → optional on-chain anchor │
       │    via custom_json          │
       └──────────────┬──────────────┘
                      ▼
              ┌───────────────────┐
              │  new node client  │
              │  verify + restore │
              │  + start sync     │
              └───────────────────┘
```

---

## Components

### 1. Node scanner

Discovers NFTLox indexer nodes:

- Seed list from a configurable registry (env, JSON file, or protocol-level `l2_nodes` table if published on-chain).
- HTTP probes against each `/api/status` and `/api/state-root`.
- Tracks endpoint health over time (latency, error rate, uptime window).

### 2. Node scorer

Quality score per node, combining:

| Metric | Weight | Why |
|---|---|---|
| `blocks_behind` (from `/api/status`) | high | Stale nodes = stale state-roots = useless for snapshots. |
| `state_root` consensus agreement | critical | A node whose root disagrees with the majority is suspect (bug, attack, or fork). |
| 7-day uptime | medium | Proxy for operator seriousness. |
| p50 / p99 response latency | low | Signal, not gate. |
| Protocol/schema version alignment | critical | Must match the publisher's expected schema. |

**Consensus rule for snapshot pick**: require agreement on `state_root` from ≥ 2/3 of scored nodes at a given block height. If no quorum, abort the snapshot cycle — never publish a lonely root.

### 3. Snapshot producer

Reads from **either**:

- A Postgres streaming replica of a trusted indexer (preferred — zero impact on the source), or
- The operator's own indexer database (smaller setups).

Then:

- `pg_dump -Fc` (custom format, parallelisable on restore).
- Piped through `zstd -19 --long=27` (long-range mode, ~60–75% size reduction for Postgres dumps with heavy JSON).
- Computes SHA-256 during the stream (no second pass).
- Captures `(at_block, block_id, state_root, nft_count, collection_count, schema_version)` from the same txn that started the dump — coherent with the byte output.

### 4. Storage adapters

Pluggable. MVP targets:

| Backend | Use case |
|---|---|
| **IPFS** (via `kubo` daemon or remote pinning API) | Decentralised distribution. Content-addressed → tampering is detectable by CID. |
| **S3 / R2 / any HTTPS** | Operator-hosted mirror. Fast for private deployments. |
| **pg_basebackup + WAL archive** | For nodes that want to start as a streaming replica rather than a point-in-time restore. |

Multiple backends can be used in parallel — the manifest lists all valid URLs for redundancy.

### 5. Manifest + attestation

Each publish emits a signed JSON manifest:

```jsonc
{
	"version": "1.0",
	"at_block": 106000000,
	"block_id": "0650a3c0…",             // verifiable against Hive
	"state_root": "sha256:…",             // matches /api/state-root at at_block
	"schema_version": "0.11.0",
	"nft_count": 152340,
	"collection_count": 1217,
	"format": "pg_dump-custom+zstd",
	"compression": { "algo": "zstd", "level": 19, "long": 27 },
	"size_bytes": 8_400_000_000,
	"sha256": "…",
	"urls": [
		"ipfs://bafy…",
		"https://snapshots.nftlox.io/v1/106000000.dump.zst"
	],
	"produced_at": "2026-05-01T12:00:00Z",
	"producer": "gametest.ing",
	"signature": "…"                      // posting-key sig over the above
}
```

Optionally, the producer broadcasts a `custom_json` on Hive with the manifest SHA-256 — turning the chain itself into a trust anchor. Multiple producers can anchor the same snapshot; divergence between anchors surfaces bad actors immediately.

### 6. Verifier / restore client

What a new node (or any service) does to consume a snapshot:

1. Fetch a manifest (from gossip, a registry, or direct URL).
2. If on-chain anchor is present: verify the `custom_json` exists at the stated block and its SHA matches the manifest.
3. Cross-check `state_root` against ≥ 2 live indexer nodes at block ≥ `at_block`.
4. Download the dump, verify SHA-256 during decompression.
5. `pg_restore` into an empty NFTLox schema.
6. Start `@nftlox/indexer` with `last_block = at_block`; it resumes live sync from `at_block + 1`.
7. After first catch-up cycle, re-check `/api/state-root` against peers. Any mismatch → abort and wipe.

---

## Trust model

The service does **not** require trusting any single publisher. The stacked defences:

1. **Content addressing** (IPFS CID / SHA-256) — byte-level integrity.
2. **State-root cross-check** — ≥ 2 independent live indexers must return the same root at the snapshot block. This reuses the existing `/api/state-root` endpoint (currently O(1) XOR hash).
3. **On-chain attestation (optional)** — one or more producers publish the manifest SHA on Hive via `custom_json`. Because Hive is immutable, a tampered snapshot cannot be retrofitted with a valid past anchor.
4. **Protocol-version gate** — mismatched `schema_version` is fatal: the verifier refuses to restore across incompatible schemas.

A verifier that skips any of these steps opts into a weaker model — the publisher's attestation alone (like a signed `pg_dump` download from a vendor).

---

## Compression strategy

Postgres dumps of NFTLox-shaped data (heavy JSONB in `nfts.data`, `nfts.schema_snapshot`, `collections.schema`, `invalid_operations.raw_payload`) compress very well with modern algorithms.

| Algo | Level | Target size ratio | Decompress speed | When to use |
|---|---|---|---|---|
| zstd | 3  | ~40% | very fast | hot distribution (CDN) |
| zstd | 19 + long | ~25-30% | fast | cold archive (IPFS pinning) |
| xz | 9 | ~22% | slow | rarely — zstd-19 is close enough and restore is faster |

Default: **zstd -19 --long=27** for IPFS archives, **zstd -3** for HTTPS mirrors where bandwidth is cheap but we prefer fast restores.

For a hypothetical 25 GB logical dump, expect ~6–8 GB on the wire and ~3–5 minute restore on modern hardware.

---

## Operational modes

The same binary supports three modes, selected by env:

### `publisher`

Requires:
- Access to a read-only Postgres source (replica preferred, own DB acceptable).
- At least one storage backend (IPFS daemon URL, S3 creds, or basebackup target).
- Optional: Hive posting key for on-chain attestation.
- Optional: Hive active key if publishing to IPFS via a paid pinning service (unrelated to NFTLox protocol).

Loop:
1. Wait until `at_block % N == 0` (e.g. N = 100_000) or cron trigger.
2. Run scanner/scorer → confirm quorum `state_root` at `at_block`.
3. Snapshot + compress + hash.
4. Upload to all configured backends.
5. Sign manifest, optionally anchor on-chain.
6. Expose manifest at `/manifests/latest` for gossip consumers.

### `verifier`

Takes a manifest URL and a target empty Postgres DSN. Performs the full verify-and-restore flow described above. Exits zero on success, non-zero with actionable error on any defence failure.

### `registry`

Lightweight HTTP service that aggregates manifests from multiple publishers and serves:

- `GET /manifests` — list of known manifests with scores.
- `GET /manifests/:block` — all manifests for a given block height (cross-publisher comparison).
- `GET /nodes` — scanner output: healthy NFTLox indexer nodes with scores.

---

## Non-goals

- **Not a replacement for the live indexer.** Snapshots cover bootstrap; the new node still runs the full indexer afterwards.
- **Not a state-transition proof system.** No STARKs, no ZK. Trust derives from state-root comparison across independent indexers + on-chain anchor.
- **Not a generic Postgres backup tool.** It is NFTLox-schema-aware: it asserts `schema_version`, includes the state-root, and rejects cross-schema restores.
- **Not tied to a specific storage backend.** IPFS is a first-class target but operators can ship to S3/R2/MinIO with zero code changes.

---

## When to implement

Today the testnet database is tiny (< 100 MB, few-thousand-block replay in seconds). Building this service now is premature.

Trigger conditions for moving from design → implementation:

| Signal | Threshold |
|---|---|
| Cold-start replay time on average hardware | > 30 min |
| Compressed DB size | > 5 GB |
| Independent indexer node count | ≥ 3 running nodes |
| Governance/stakeholder request for fast bootstrap | explicit |

When any two of those hit, open a tracking issue and start with phase 1 below.

---

## Roadmap

### Phase 0 — design
This document. Done.

### Phase 1 — minimal publisher
- `pg_dump -Fc | zstd` to local file.
- Single S3 backend.
- Manifest with state-root but no on-chain anchor.
- Manual consumption (operators share the manifest URL).

### Phase 2 — node scanner and scoring
- Scanner for discovering peers.
- Scorer with state-root consensus rule.
- Refuse to publish without quorum.

### Phase 3 — IPFS + on-chain attestation
- IPFS publish via pinning API.
- `custom_json` attestation from a producer account.
- Verifier checks the anchor.

### Phase 4 — incremental snapshots
- Periodic full snapshots (monthly).
- Diff snapshots (daily) = serialised `confirmed_operations` and projected-state deltas.
- Verifier applies full → diffs → starts live sync.

### Phase 5 — pg_basebackup mode
- For operators who prefer to boot as a streaming replica rather than a restored copy.
- WAL archive served alongside basebackup; replica catches up via standard Postgres replication.

---

## Relationship to existing NFTLox packages

| Package | Relationship |
|---|---|
| `@nftlox/indexer` | Source of truth for schema. This service reads from a replica of it (or a trusted peer's DB). Must never be coupled into the sync loop. |
| `@nftlox/protocol` | Must import `PROTOCOL_ID`, `PROTOCOL_VERSION`, `PROTOCOL_GENESIS_BLOCK` to validate schema compatibility in manifests. |
| `@nftlox/sdk` | Produces the `custom_json` for on-chain anchor attestation. Reuses SDK builders — no hand-assembled ops. |
| `@nftlox/packs-engine` | Unrelated. Consumes snapshots only as any other client would (bootstrap, then read via the live indexer API). |

---

## Security considerations (open questions)

These must be resolved before phase 1:

1. **Who is allowed to anchor a manifest on-chain?** Any Hive account? A registered L2 node (`l2_nodes` table)? A hardcoded allowlist? Decision affects the trust model fundamentally.
2. **What happens if two producers anchor conflicting manifests for the same block?** Clients must detect and refuse; which one is "canonical" is an open governance question.
3. **Replay across `schema_version` upgrades**: if a node restores a phase-N snapshot and the protocol is at phase N+1, the migration path must be explicit. Proposal: verifier refuses cross-version restores; publishers must republish after every schema version bump.
4. **Private data**: does the indexer schema ever hold PII or sensitive data? (Today: no — all fields derive from public chain ops.) Must re-audit before phase 1.
5. **DoS via oversized manifests**: verifier must cap manifest size (< 64 KB) and refuse URLs beyond a configured max dump size.

---

## References

- Existing state-root endpoint: `packages/indexer/src/api/routes/state-root.ts`
- Chain-anchor verification pattern: `packages/indexer/src/scanner/chain-anchors.ts`
- Protocol version constants: `packages/protocol/src/constants.ts`
- Monorepo structure memory: `project_workspace_structure`

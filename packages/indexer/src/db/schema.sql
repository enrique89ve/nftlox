-- NFTLox Indexer Schema (testnet — clean rebuild)

-- ============ ENUMS ============

DO $$ BEGIN
	CREATE TYPE nft_kind AS ENUM ('seed', 'instance');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE nft_status AS ENUM ('active', 'listed', 'pending_sale', 'lent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- nft_owner_action enumerates every protocol action that can change ownership.
-- Keep in lock-step with `chk_nfts_owner_action` and the router's ACTION_*
-- constants. Adding a new action is ALTER TYPE ... ADD VALUE (online in PG).
DO $$ BEGIN
	CREATE TYPE nft_owner_action AS ENUM ('mint', 'bulk_distribute', 'transfer', 'nft_transfer_from', 'buy');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE l2_node_status AS ENUM ('active', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============ TABLES ============

-- Sync state (singleton row)
CREATE TABLE IF NOT EXISTS sync_state (
	id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_block BIGINT NOT NULL DEFAULT 0,
	genesis_block BIGINT NOT NULL DEFAULT 0,
	-- Last HEAD block observed from the Hive node. Updated by the scanner each
	-- tick alongside last_block. Consumers (e.g. /api/multisig) use this for
	-- the chain-time reference (see hive_head_time) and to detect Hive RPC
	-- outage via wall-clock staleness.
	hive_head_block BIGINT NOT NULL DEFAULT 0,
	-- Last irreversible block reported by chain consensus. Tracked separately
	-- from last_block (the indexer's processed cursor) so /api/multisig can
	-- diff hive_irreversible_block - last_block to detect a real processing
	-- backlog, without injecting the ~15-block finality gap that
	-- hive_head_block - last_block would always carry.
	hive_irreversible_block BIGINT NOT NULL DEFAULT 0,
	-- Timestamp of the observed Hive HEAD block. Lets the API estimate chain
	-- time for `last_block` without trusting the local wall clock.
	hive_head_time TIMESTAMPTZ,
	-- schema_hash pins this row to a known schema.sql content. On mismatch the
	-- bootstrap truncates all data and re-syncs from genesis (testnet policy).
	schema_hash TEXT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sync_state (last_block) VALUES (0) ON CONFLICT (id) DO NOTHING;

-- State root (singleton row) — incremental XOR over per-NFT SPV row hashes.
-- See src/utils/state-root-hash.ts for the algorithm and invariants.
-- state_root is stored as raw 32-byte BYTEA (not hex) so XOR arithmetic runs
-- in application code against Uint8Array without parse overhead. Endpoint
-- serializes to "sha256:<64-hex>" for on-wire use.
CREATE TABLE IF NOT EXISTS state_meta (
	id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	state_root BYTEA NOT NULL CHECK (octet_length(state_root) = 32),
	nft_count BIGINT NOT NULL DEFAULT 0 CHECK (nft_count >= 0),
	last_block_num BIGINT NOT NULL DEFAULT 0,
	-- F3.B — divergence flag. NULL = no divergence detected against any peer's
	-- `node_state_checkpoint`. Non-null = highest checkpoint block_num where we
	-- observed disagreement between our local state_root and another node's. The
	-- comparator tick advances this monotonically (GREATEST). Operator clears it
	-- manually with `UPDATE state_meta SET divergent_at_block = NULL WHERE id=1`
	-- after investigating; if the disagreement persists in `l2_node_checkpoints`
	-- the next tick re-sets the flag. NOT a hash input — see state-root-hash.ts.
	divergent_at_block BIGINT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO state_meta (id, state_root) VALUES (1, decode(repeat('00', 32), 'hex'))
	ON CONFLICT (id) DO NOTHING;

-- Collections
CREATE TABLE IF NOT EXISTS collections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	symbol VARCHAR(10) NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,9}$'),
	creator TEXT NOT NULL,
	-- Canonical DNA of this collection. Pure function of `id` (see
	-- protocol/dna.ts::generateOriginDna). Stored here as the single source of
	-- truth so seeds and instances can JOIN for it — never duplicated on
	-- `nfts` rows. Immutable post-insert (enforced by
	-- prevent_collection_immutable_update).
	origin_dna TEXT NOT NULL,
	total_potential INTEGER NOT NULL DEFAULT 0 CHECK (total_potential >= 0),
	-- Hard cap on instances mintable across the collection. 0 = unlimited
	-- (subject to per-creator caps). When > 0, must be a multiple of 1000
	-- (INSTANCE_FEE_PER_N) — enforced at the protocol/SDK layer; the CHECK
	-- here is only the >= 0 invariant the DB needs to know about.
	max_instances INTEGER NOT NULL DEFAULT 0 CHECK (max_instances >= 0),
	description TEXT,
	image_url TEXT,
	external_url TEXT,
	transferable BOOLEAN NOT NULL DEFAULT TRUE,
	burnable BOOLEAN NOT NULL DEFAULT TRUE,
	royalty_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (royalty_pct >= 0 AND royalty_pct <= 50),
	royalty_recipient TEXT,
	schema JSONB,
	schema_version INTEGER NOT NULL DEFAULT 0,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NFTs (unified: seeds and instances)
--
-- CHECK constraints:
-- - chk_nfts_listed_coherent: status='listed' requires full listing snapshot so
--   the marketplace never serves a NULL price.
-- - chk_nfts_pending_sale_coherent: status='pending_sale' requires the full
--   sale_* snapshot, and any other status forbids sale_* population. Keeps the
--   buy_commitment projection self-consistent with its state discriminator.
-- - chk_nfts_pending_sale_has_listing: a buy_commitment always reserves a live
--   listing, so listing_* must remain populated while status='pending_sale'.
-- - chk_nfts_supply_bounded: distributed + reserved_supply <= max_supply when
--   bounded (max_supply > 0). Hard backstop against a buggy handler writing over
--   the cap; `supply_exhausted` (generated) only reports the state.
CREATE TABLE IF NOT EXISTS nfts (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL REFERENCES collections(id),
	nft_type nft_kind NOT NULL,
	status nft_status NOT NULL DEFAULT 'active',
	edition INTEGER NOT NULL DEFAULT 1,
	owner TEXT NOT NULL,
	-- origin_dna lives on `collections` — read via JOIN, never cached here.
	-- nft_dna: the DNA hash emitted under the generateSeedDna() /
	-- generateInstanceDna() algorithm live at the moment this row was created.
	-- Kept as an IMMUTABLE AUDIT TRAIL (not a cache of a pure function) because
	-- the algorithm can rotate — domain constants or preimage shape may change
	-- across hardforks — and only the stored value reflects what was actually
	-- signed on-chain in the original custom_json. Same pattern as
	-- created_*/owner_* audit columns. Per-row, never shared between rows
	-- of the same seed (each instance has its own hash keyed by instance_number).
	nft_dna TEXT,
	name TEXT NOT NULL,
	image_url TEXT,
	max_supply INTEGER NOT NULL DEFAULT 1 CHECK (max_supply >= 0),
	distributed INTEGER NOT NULL DEFAULT 0 CHECK (distributed >= 0),
	reserved_supply INTEGER NOT NULL DEFAULT 0,
	supply_exhausted BOOLEAN GENERATED ALWAYS AS (max_supply > 0 AND (distributed + reserved_supply) >= max_supply) STORED,
	seed_id TEXT REFERENCES nfts(id) ON DELETE SET NULL,
	instance_number INTEGER,
	-- Creator-chosen per-seed asset identifier. Bound to seeds only via the
	-- partial UNIQUE index below. Populated when indexer canonical-validates
	-- `id = generateDeterministicSeedId(collection_id, art_id)`. Instances
	-- inherit art via seed_id FK and leave art_id NULL.
	art_id TEXT,
	immutable_data JSONB,
	data_operation_id TEXT,
	data_hash TEXT,
	schema_version INTEGER,
	previous_owner TEXT,
	owner_operation_id TEXT NOT NULL,
	owner_action nft_owner_action NOT NULL,
	owner_block_num BIGINT NOT NULL,
	listing_id TEXT,
	listing_tx_id TEXT,
	listing_price NUMERIC(18,3),
	listing_currency TEXT,
	listing_expires_at TIMESTAMPTZ,
	listing_marketplace TEXT,
	-- Buy-commitment reservation set by handleBuyCommitment. When
	-- `status='pending_sale'` the five sale_* columns are all populated: the
	-- buyer account, the settlement node that emitted the commitment, the
	-- block when the reservation expires, the tx_id of the buy_commitment op
	-- (audit trail), and the digest of the buyer's buy-tx that the node
	-- committed to co-sign. handleBuy matches currentTxId against
	-- sale_commitment_buy_tx_hash to refuse settling a buy-tx that was not
	-- the one reserved. The matching `buy` consumes the reservation atomically
	-- (status→'active', nulls sale_* + listing_* in the same UPDATE). If no
	-- buy lands by the deadline, the sync engine's lazy sweep rolls the row
	-- back to 'listed' — fully deterministic because the decision key is
	-- `currentBlock`, not wall-clock.
	sale_buyer TEXT,
	sale_settlement_node TEXT,
	sale_expires_block BIGINT,
	sale_commitment_op_tx_id CHAR(40),
	sale_commitment_buy_tx_hash CHAR(40),
	created_operation_id TEXT NOT NULL,
	created_block_num BIGINT NOT NULL,
	created_tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CONSTRAINT chk_nfts_listed_coherent CHECK (
		status <> 'listed'
		OR (listing_price IS NOT NULL
			AND listing_currency IS NOT NULL
			AND listing_id IS NOT NULL
			AND listing_tx_id IS NOT NULL)
	),
	-- DB-level coherence backstop for the on-chain buy_commitment state
	-- machine: `status='pending_sale'` requires the full five-tuple sale_*
	-- snapshot, and every other status forbids any sale_* column from being
	-- populated. Any handler that writes an inconsistent transition hits this
	-- constraint instead of silently projecting a broken state-root.
	CONSTRAINT chk_nfts_pending_sale_coherent CHECK (
		(status = 'pending_sale'
			AND sale_buyer IS NOT NULL
			AND sale_settlement_node IS NOT NULL
			AND sale_expires_block IS NOT NULL
			AND sale_commitment_op_tx_id IS NOT NULL
			AND sale_commitment_buy_tx_hash IS NOT NULL)
		OR
		(status <> 'pending_sale'
			AND sale_buyer IS NULL
			AND sale_settlement_node IS NULL
			AND sale_expires_block IS NULL
			AND sale_commitment_op_tx_id IS NULL
			AND sale_commitment_buy_tx_hash IS NULL)
	),
	-- `pending_sale` is a reservation on an already-listed NFT; the listing
	-- row must stay populated so `buy` can resolve price/currency against it.
	-- Clearing listing_* while keeping status='pending_sale' would leave the
	-- buy handler without a price to validate transfers against.
	CONSTRAINT chk_nfts_pending_sale_has_listing CHECK (
		status <> 'pending_sale'
		OR (listing_id IS NOT NULL
			AND listing_tx_id IS NOT NULL
			AND listing_price IS NOT NULL
			AND listing_currency IS NOT NULL)
	),
	CONSTRAINT chk_nfts_supply_bounded CHECK (
		max_supply = 0 OR (distributed + reserved_supply) <= max_supply
	)
);

-- Archived collections (lightweight audit — blockchain is source of truth)
CREATE TABLE IF NOT EXISTS archived_collections (
	id TEXT PRIMARY KEY,
	creator TEXT NOT NULL,
	tx_id TEXT NOT NULL
);

-- Burned NFTs (lightweight audit — blockchain is source of truth)
CREATE TABLE IF NOT EXISTS burned_nfts (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL,
	burned_by TEXT NOT NULL,
	tx_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL
);

-- Invalid operations (audit trail)
-- operation_id is the HafAH-assigned unique ID per custom_json within a transaction.
-- This allows distinguishing multiple protocol ops in the same Hive tx.
CREATE TABLE IF NOT EXISTS invalid_operations (
	id BIGSERIAL PRIMARY KEY,
	block_num BIGINT NOT NULL,
	tx_id TEXT,
	operation_id TEXT,
	signer TEXT,
	action TEXT,
	reason TEXT NOT NULL,
	raw_payload JSONB,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invalid_ops_unique ON invalid_operations(tx_id, COALESCE(operation_id, '')) WHERE tx_id IS NOT NULL;
-- Serves both the time-based TTL DELETE and the size-based pruning (MAX_ROWS_PER_TABLE).
-- Without it, retention degenerates to a seq scan as the table grows — exactly the
-- failure mode the pruner exists to prevent under a flooding bot.
CREATE INDEX IF NOT EXISTS idx_invalid_ops_indexed_at ON invalid_operations(indexed_at);

-- Confirmed operations (append-only tracking of successful handler executions).
-- Stores immutable NFT IDs for lightweight per-NFT operations. Bulk creation ops
-- can intentionally store an empty array because each NFT stores its own origin.
-- Durable: nfts.owner_operation_id / nfts.created_operation_id and auditor
-- invariants join back to this table, so retention cleanup must not prune it.
CREATE TABLE IF NOT EXISTS confirmed_operations (
	operation_id TEXT PRIMARY KEY,
	tx_id TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	signer TEXT NOT NULL,
	action TEXT NOT NULL,
	nft_ids TEXT[] NOT NULL DEFAULT '{}',
	created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_confirmed_ops_tx ON confirmed_operations(tx_id);
-- Ordered history queries and forensic inspection by operation timestamp.
CREATE INDEX IF NOT EXISTS idx_confirmed_ops_created_at ON confirmed_operations(created_at);

-- Orphaned buys
CREATE TABLE IF NOT EXISTS orphaned_buys (
	id BIGSERIAL PRIMARY KEY,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	operation_id TEXT,
	buyer TEXT NOT NULL,
	nft_id TEXT,
	reason TEXT NOT NULL,
	transfers JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orphaned_buys_unique ON orphaned_buys(tx_id, COALESCE(operation_id, ''));
-- Serves both the time-based TTL DELETE and the size-based pruning (MAX_ROWS_PER_TABLE).
-- Same rationale as idx_invalid_ops_indexed_at.
CREATE INDEX IF NOT EXISTS idx_orphaned_buys_created_at ON orphaned_buys(created_at);

-- ============ ALLOWANCE TABLES ============

CREATE TABLE IF NOT EXISTS nft_allowances (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id) ON DELETE CASCADE,
	owner TEXT NOT NULL,
	approved_spender TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collection_allowances (
	owner TEXT NOT NULL,
	spender TEXT NOT NULL,
	collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
	approved BOOLEAN NOT NULL DEFAULT TRUE,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (owner, spender, collection_id)
);

-- ============ DATA OPERATORS ============

CREATE TABLE IF NOT EXISTS data_operators (
	collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
	operator TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (collection_id, operator)
);

-- ============ LENDING ============

CREATE TABLE IF NOT EXISTS nft_loans (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id) ON DELETE CASCADE,
	lender TEXT NOT NULL,
	borrower TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============ SCHEMA VERSIONS (append-only hash chain) ============

CREATE TABLE IF NOT EXISTS schema_versions (
	collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	schema JSONB NOT NULL,
	schema_hash TEXT NOT NULL,
	prev_hash TEXT,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	PRIMARY KEY (collection_id, version)
);

-- ============ SALES (append-only financial record) ============

CREATE TABLE IF NOT EXISTS sales (
	id BIGSERIAL PRIMARY KEY,
	nft_id TEXT NOT NULL,
	collection_id TEXT NOT NULL,
	listing_id TEXT NOT NULL,
	seller TEXT NOT NULL,
	buyer TEXT NOT NULL,
	gross_amount NUMERIC(18,3) NOT NULL CHECK (gross_amount > 0),
	currency TEXT NOT NULL,
	royalty_amount NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (royalty_amount >= 0),
	protocol_fee NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (protocol_fee >= 0),
	seller_net NUMERIC(18,3) NOT NULL CHECK (seller_net >= 0),
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	CHECK (seller <> buyer),
	UNIQUE (nft_id, listing_id, tx_id)
);

-- ============ OWNER NFT COUNTS ============

CREATE TABLE IF NOT EXISTS owner_nft_counts (
	owner TEXT PRIMARY KEY,
	total INT NOT NULL DEFAULT 0 CHECK (total >= 0),
	seeds INT NOT NULL DEFAULT 0 CHECK (seeds >= 0),
	instances INT NOT NULL DEFAULT 0 CHECK (instances >= 0)
);

-- ============ COLLECTION STATS (denormalized) ============

CREATE TABLE IF NOT EXISTS collection_stats (
	collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
	total INT NOT NULL DEFAULT 0 CHECK (total >= 0),
	seeds INT NOT NULL DEFAULT 0 CHECK (seeds >= 0),
	instances INT NOT NULL DEFAULT 0 CHECK (instances >= 0),
	listed INT NOT NULL DEFAULT 0 CHECK (listed >= 0),
	burned INT NOT NULL DEFAULT 0 CHECK (burned >= 0)
);

-- ============ L2 NODES ============

CREATE TABLE IF NOT EXISTS l2_nodes (
	account TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,
	status l2_node_status NOT NULL DEFAULT 'active',
	-- Block number of the most recent accepted `node_heartbeat` from this account.
	-- NULL until the first heartbeat. Written by `handleNodeHeartbeat`, also used
	-- by the handler's rate-limit guard (MIN_HEARTBEAT_INTERVAL_BLOCKS).
	last_heartbeat_block BIGINT,
	-- Boundary block (multiple of STATE_CHECKPOINT_INTERVAL_BLOCKS) of the most
	-- recent `node_state_checkpoint` this LOCAL daemon has emitted to chain.
	-- NULL until the first emission. Read at daemon startup so a restart does
	-- not re-broadcast checkpoints already on-chain. Other accounts' rows track
	-- the same field for their own emissions; this is per-account, not global.
	last_emitted_checkpoint_block BIGINT,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only heartbeat log. One row per accepted `node_heartbeat` op.
-- `account` references `l2_nodes` so a heartbeat from an unregistered account is
-- structurally impossible (the handler also rejects it up-front with a clear
-- error message, but the FK is the last line of defence).
CREATE TABLE IF NOT EXISTS l2_node_heartbeats (
	id BIGSERIAL PRIMARY KEY,
	account TEXT NOT NULL REFERENCES l2_nodes(account) ON DELETE CASCADE,
	block_num BIGINT NOT NULL,
	state_root TEXT NOT NULL,
	indexer_version TEXT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Serves "latest heartbeat from account" lookups (registry freshness displays,
-- divergence probes). DESC on block_num keeps the top-N query index-only.
CREATE INDEX IF NOT EXISTS idx_l2_node_heartbeats_account_block ON l2_node_heartbeats(account, block_num DESC);

-- Append-only state-root checkpoint log. One row per accepted
-- `node_state_checkpoint` op. Mirrors `l2_node_heartbeats` minus the indexer
-- version (checkpoints are a consensus probe — version metadata would muddy
-- the equality semantics F3.B compares on). Rows from peer nodes accumulate
-- here and are read by the F3.B detector; this table never feeds the local
-- SPV state-root.
CREATE TABLE IF NOT EXISTS l2_node_checkpoints (
	id BIGSERIAL PRIMARY KEY,
	account TEXT NOT NULL REFERENCES l2_nodes(account) ON DELETE CASCADE,
	block_num BIGINT NOT NULL,
	state_root TEXT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Serves "latest checkpoint from account at boundary B" lookups. (account,
-- block_num) is the natural lookup pair for divergence probes; DESC on
-- block_num keeps the top-N variant index-only.
CREATE INDEX IF NOT EXISTS idx_l2_node_checkpoints_account_block ON l2_node_checkpoints(account, block_num DESC);

-- Local-only snapshot of state_root at every multiple-of-N block boundary the
-- sync engine HAS observed (i.e. boundaries that landed exactly on a batch's
-- final block). Never receives chain data — populated by sync-engine.ts inside
-- the same write transaction as `flushStateRootBuffer`. Drives the daemon's
-- decision of which checkpoints are publishable on-chain via
-- `node_state_checkpoint`.
CREATE TABLE IF NOT EXISTS state_root_checkpoints (
	block_num BIGINT PRIMARY KEY,
	state_root BYTEA NOT NULL,
	recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============ MULTISIG LOCKS ============
--
-- Multisig signing is serialized per logical resource inside a single API
-- process. These tables are node-local and intentionally OUT of consensus:
-- they prevent this node from issuing two competing signatures while the
-- underlying unsigned tx is still valid, but they do not alter on-chain state.

-- Scoped by NFT listing: a single node must not co-sign two competing buys for
-- the same NFT while the first unsigned tx is still within its broadcast
-- window. Holder is a deterministic tx identity so exact retries can refresh
-- the lock, while a distinct in-flight buyer attempt receives `NFT_LOCKED`.
CREATE TABLE IF NOT EXISTS multisig_buy_locks (
	nft_id TEXT PRIMARY KEY,
	listing_id TEXT NOT NULL,
	listing_tx_id TEXT NOT NULL,
	holder TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multisig_buy_locks_expires ON multisig_buy_locks(expires_at);

-- Scoped by creator for create_collection signing. The `symbol` column remains
-- in the key for schema compatibility; current code stores a fixed internal
-- scope there so cap checks by creator cannot race across different symbols.
CREATE TABLE IF NOT EXISTS multisig_collection_locks (
	creator TEXT NOT NULL,
	symbol TEXT NOT NULL,
	holder TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	PRIMARY KEY (creator, symbol)
);
CREATE INDEX IF NOT EXISTS idx_multisig_collection_locks_expires ON multisig_collection_locks(expires_at);

-- ============ INDEXES ============
--
-- Diet principle: every index must serve an actual query in the codebase.
-- "Maybe some day" is a write-amplification tax we don't pay on master. Anything
-- added here MUST come with the query that reads it.

-- Collections
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_creator_symbol ON collections(creator, symbol);
-- Presence in `collections` == active. Archived collections live in `archived_collections`.
CREATE INDEX IF NOT EXISTS idx_collections_created_at ON collections(created_at DESC);

-- NFTs
CREATE INDEX IF NOT EXISTS idx_nfts_owner_created ON nfts(owner, created_at DESC);
-- Logical instance identity is (seed_id, instance_number). `id` is also
-- deterministic from that tuple, but the DB must reject duplicate ordinals even
-- if a future handler bug supplies a different id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nfts_seed_instances ON nfts(seed_id, instance_number) WHERE seed_id IS NOT NULL;
-- Serves bulk-distribute idempotency: WHERE seed_id = X AND created_operation_id = Y.
CREATE INDEX IF NOT EXISTS idx_nfts_seed_created_operation ON nfts(seed_id, created_operation_id) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_owner_type_status ON nfts(owner, nft_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_owner_active_instances ON nfts(owner, created_at DESC) WHERE nft_type = 'instance' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_nfts_owner_active_seeds ON nfts(owner, collection_id) WHERE nft_type = 'seed' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_nfts_seeds_available ON nfts(collection_id, distributed) WHERE nft_type = 'seed' AND supply_exhausted = FALSE;
CREATE INDEX IF NOT EXISTS idx_nfts_collection_type ON nfts(collection_id, nft_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_listed ON nfts(listing_price, listing_currency) WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_nfts_listed_recent ON nfts(created_at DESC) WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_nfts_listing_id ON nfts(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_listing_expires ON nfts(listing_expires_at) WHERE status = 'listed' AND listing_expires_at IS NOT NULL;
-- buy_commitment lookups (all partial on status='pending_sale'):
--   buyer_pending:   per-buyer reservation count (audit / UI).
--   sale_expires:    lazy sweep of expired reservations in sync-engine (per-block
--                    UPDATE ... WHERE sale_expires_block < currentBlock).
--   settlement_node: MAX_ACTIVE_COMMITMENTS_PER_NODE enforcement in
--                    handleBuyCommitment, plus per-node metrics / dashboards.
-- Partial indexes keep each at ~zero cost whenever the NFT is not reserved.
CREATE INDEX IF NOT EXISTS idx_nfts_sale_buyer_pending ON nfts(sale_buyer) WHERE status = 'pending_sale';
CREATE INDEX IF NOT EXISTS idx_nfts_sale_expires ON nfts(sale_expires_block) WHERE status = 'pending_sale';
CREATE INDEX IF NOT EXISTS idx_nfts_sale_settlement_node ON nfts(sale_settlement_node) WHERE status = 'pending_sale';
-- DB-level backstop against non-canonical seeds: two seeds in the same collection
-- cannot share an art_id. Paired with the application-level canonical check in
-- handleMint, this defends against a handler bug ever bypassing the recomputation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nfts_collection_art_unique ON nfts(collection_id, art_id) WHERE nft_type = 'seed' AND art_id IS NOT NULL;

-- Invalid operations: idx_invalid_ops_unique covers lookups by tx_id via leading col.
-- (no standalone indexes — the unique partial index serves all query shapes)

-- Orphaned buys: idx_orphaned_buys_unique covers lookups by tx_id via leading col.

-- Allowances: nft_allowances PK is nft_id; collection_allowances PK leads with owner.
-- idx_collection_allowances_collection supports CASCADE delete on collection archive
-- (without it PG falls back to seq scan on the referencing table).
CREATE INDEX IF NOT EXISTS idx_collection_allowances_collection ON collection_allowances(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_active ON collection_allowances(owner, collection_id) WHERE approved = TRUE;

-- Data operators: PK is (collection_id, operator) — leading col serves CASCADE.

-- Lending
CREATE INDEX IF NOT EXISTS idx_nft_loans_lender ON nft_loans(lender);
CREATE INDEX IF NOT EXISTS idx_nft_loans_borrower ON nft_loans(borrower);

-- Schema versions
CREATE INDEX IF NOT EXISTS idx_schema_versions_hash ON schema_versions(schema_hash);

-- Sales
CREATE INDEX IF NOT EXISTS idx_sales_nft ON sales(nft_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sales_collection ON sales(collection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_buyer ON sales(buyer, created_at DESC);

-- ============================================================================
-- TRIGGERS — defense-in-depth against projection corruption
-- ============================================================================
--
-- The application code never attempts to UPDATE these columns post-insert; the
-- triggers exist to catch a future handler bug, schema drift, or manual ad-hoc
-- SQL that would silently corrupt projected state and desynchronize the
-- cross-replica state_root hash.
--
-- IS DISTINCT FROM is NULL-safe: (NULL, NULL) → false (no change), (NULL, 'x')
-- → true, ('x', 'x') → false. Plain `=` would treat NULL transitions as
-- "unchanged" and let them through silently.

CREATE OR REPLACE FUNCTION prevent_nft_immutable_update()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id THEN
		RAISE EXCEPTION 'nfts.id is immutable for %', OLD.id;
	END IF;
	IF NEW.collection_id IS DISTINCT FROM OLD.collection_id THEN
		RAISE EXCEPTION 'nfts.collection_id is immutable for %', OLD.id;
	END IF;
	IF NEW.nft_type IS DISTINCT FROM OLD.nft_type THEN
		RAISE EXCEPTION 'nfts.nft_type is immutable for %', OLD.id;
	END IF;
	IF NEW.edition IS DISTINCT FROM OLD.edition THEN
		RAISE EXCEPTION 'nfts.edition is immutable for %', OLD.id;
	END IF;
	IF NEW.nft_dna IS DISTINCT FROM OLD.nft_dna THEN
		RAISE EXCEPTION 'nfts.nft_dna is immutable for %', OLD.id;
	END IF;
	IF NEW.name IS DISTINCT FROM OLD.name THEN
		RAISE EXCEPTION 'nfts.name is immutable for %', OLD.id;
	END IF;
	IF NEW.image_url IS DISTINCT FROM OLD.image_url THEN
		RAISE EXCEPTION 'nfts.image_url is immutable for %', OLD.id;
	END IF;
	IF NEW.max_supply IS DISTINCT FROM OLD.max_supply THEN
		RAISE EXCEPTION 'nfts.max_supply is immutable for %', OLD.id;
	END IF;
	IF NEW.seed_id IS DISTINCT FROM OLD.seed_id THEN
		RAISE EXCEPTION 'nfts.seed_id is immutable for %', OLD.id;
	END IF;
	IF NEW.instance_number IS DISTINCT FROM OLD.instance_number THEN
		RAISE EXCEPTION 'nfts.instance_number is immutable for %', OLD.id;
	END IF;
	IF NEW.art_id IS DISTINCT FROM OLD.art_id THEN
		RAISE EXCEPTION 'nfts.art_id is immutable for %', OLD.id;
	END IF;
	IF NEW.immutable_data IS DISTINCT FROM OLD.immutable_data THEN
		RAISE EXCEPTION 'nfts.immutable_data is immutable for %', OLD.id;
	END IF;
	IF NEW.schema_version IS DISTINCT FROM OLD.schema_version THEN
		RAISE EXCEPTION 'nfts.schema_version is immutable for %', OLD.id;
	END IF;
	IF NEW.created_operation_id IS DISTINCT FROM OLD.created_operation_id
	   OR NEW.created_block_num IS DISTINCT FROM OLD.created_block_num
	   OR NEW.created_tx_id IS DISTINCT FROM OLD.created_tx_id
	   OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'nfts.created_* fields are immutable for %', OLD.id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_nft_immutable_update ON nfts;
CREATE TRIGGER trg_prevent_nft_immutable_update
	BEFORE UPDATE ON nfts
	FOR EACH ROW
	EXECUTE FUNCTION prevent_nft_immutable_update();

-- owner_block_num is monotonically non-decreasing. A regression means a
-- stale/out-of-order apply would hash against an older ownership snapshot and
-- silently fork state_root across replicas.
CREATE OR REPLACE FUNCTION prevent_nft_owner_block_regression()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.owner_block_num < OLD.owner_block_num THEN
		RAISE EXCEPTION
			'nfts.owner_block_num regression for % (old=%, new=%) — SPV invariant violation',
			OLD.id, OLD.owner_block_num, NEW.owner_block_num;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_nft_owner_block_regression ON nfts;
CREATE TRIGGER trg_prevent_nft_owner_block_regression
	BEFORE UPDATE OF owner_block_num ON nfts
	FOR EACH ROW
	EXECUTE FUNCTION prevent_nft_owner_block_regression();

-- Freeze the structural identity of a collection. Only `schema` and
-- `schema_version` are legitimately mutable (set_schema flow via
-- updateCollectionSchema). Every other column is either the structural
-- identity (id/creator/symbol/total_potential) or the audit trail anchored
-- to the Hive block (block_num/tx_id/created_at). Policy fields (name,
-- description, image_url, royalty_*, transferable, burnable) are left free
-- so a future update_collection op can touch them without a schema change.

CREATE OR REPLACE FUNCTION prevent_collection_immutable_update()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id THEN
		RAISE EXCEPTION 'collections.id is immutable for %', OLD.id;
	END IF;
	IF NEW.creator IS DISTINCT FROM OLD.creator THEN
		RAISE EXCEPTION 'collections.creator is immutable for %', OLD.id;
	END IF;
	IF NEW.symbol IS DISTINCT FROM OLD.symbol THEN
		RAISE EXCEPTION 'collections.symbol is immutable for %', OLD.id;
	END IF;
	IF NEW.origin_dna IS DISTINCT FROM OLD.origin_dna THEN
		RAISE EXCEPTION 'collections.origin_dna is immutable for %', OLD.id;
	END IF;
	IF NEW.total_potential IS DISTINCT FROM OLD.total_potential THEN
		RAISE EXCEPTION 'collections.total_potential is immutable for %', OLD.id;
	END IF;
	IF NEW.max_instances IS DISTINCT FROM OLD.max_instances THEN
		RAISE EXCEPTION 'collections.max_instances is immutable for %', OLD.id;
	END IF;
	IF NEW.block_num IS DISTINCT FROM OLD.block_num THEN
		RAISE EXCEPTION 'collections.block_num is immutable for %', OLD.id;
	END IF;
	IF NEW.tx_id IS DISTINCT FROM OLD.tx_id THEN
		RAISE EXCEPTION 'collections.tx_id is immutable for %', OLD.id;
	END IF;
	IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'collections.created_at is immutable for %', OLD.id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_collection_immutable_update ON collections;
CREATE TRIGGER trg_prevent_collection_immutable_update
	BEFORE UPDATE ON collections
	FOR EACH ROW
	EXECUTE FUNCTION prevent_collection_immutable_update();

-- Counter maintenance — single source of truth in DB. Before this trigger,
-- `owner_nft_counts` and `collection_stats` were maintained by app-level
-- helpers (`adjustOwnerNftCount`, `recordCollectionMint`,
-- `recordCollectionBurn`) that each handler had to remember to call.
-- Missing one call silently drifted the counters from the actual `nfts`
-- rows; no DB-level defense existed. Moving the logic here makes INSERT /
-- DELETE / UPDATE-of-owner atomic with the counter update inside the same
-- transaction, independent of any specific handler path.
--
-- DELETE and UPDATE-of-owner RAISE EXCEPTION `'Owner NFT count missing
-- for …'` when the old owner's row is not found — preserves the exact
-- contract `adjustOwnerNftCount(-1)` had, so tests that force
-- counter-missing failure paths stay reproducible.
--
-- `collection_stats.listed` is NOT touched here — listed/unlisted state
-- is managed by the marketplace handlers via `adjustCollectionListed`
-- and is orthogonal to owner/kind counting.
CREATE OR REPLACE FUNCTION maintain_nft_counters()
RETURNS TRIGGER AS $$
DECLARE
	seed_delta_new   INTEGER;
	inst_delta_new   INTEGER;
	seed_delta_old   INTEGER;
	inst_delta_old   INTEGER;
BEGIN
	IF TG_OP = 'INSERT' THEN
		seed_delta_new := CASE WHEN NEW.nft_type = 'seed'     THEN 1 ELSE 0 END;
		inst_delta_new := CASE WHEN NEW.nft_type = 'instance' THEN 1 ELSE 0 END;

		INSERT INTO owner_nft_counts (owner, total, seeds, instances)
		VALUES (NEW.owner, 1, seed_delta_new, inst_delta_new)
		ON CONFLICT (owner) DO UPDATE SET
			total     = owner_nft_counts.total     + 1,
			seeds     = owner_nft_counts.seeds     + seed_delta_new,
			instances = owner_nft_counts.instances + inst_delta_new;

		INSERT INTO collection_stats (collection_id, total, seeds, instances, listed, burned)
		VALUES (NEW.collection_id, 1, seed_delta_new, inst_delta_new, 0, 0)
		ON CONFLICT (collection_id) DO UPDATE SET
			total     = collection_stats.total     + 1,
			seeds     = collection_stats.seeds     + seed_delta_new,
			instances = collection_stats.instances + inst_delta_new;

		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' THEN
		seed_delta_old := CASE WHEN OLD.nft_type = 'seed'     THEN 1 ELSE 0 END;
		inst_delta_old := CASE WHEN OLD.nft_type = 'instance' THEN 1 ELSE 0 END;

		UPDATE owner_nft_counts SET
			total     = total     - 1,
			seeds     = seeds     - seed_delta_old,
			instances = instances - inst_delta_old
			WHERE owner = OLD.owner;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Owner NFT count missing for %', OLD.owner;
		END IF;

		UPDATE collection_stats SET
			burned    = burned    + 1,
			total     = total     - 1,
			seeds     = seeds     - seed_delta_old,
			instances = instances - inst_delta_old
			WHERE collection_id = OLD.collection_id;

		RETURN OLD;
	END IF;

	IF TG_OP = 'UPDATE' AND OLD.owner IS DISTINCT FROM NEW.owner THEN
		-- nft_type is immutable (protected by prevent_nft_immutable_update),
		-- so OLD.nft_type == NEW.nft_type; use NEW uniformly.
		seed_delta_new := CASE WHEN NEW.nft_type = 'seed'     THEN 1 ELSE 0 END;
		inst_delta_new := CASE WHEN NEW.nft_type = 'instance' THEN 1 ELSE 0 END;

		UPDATE owner_nft_counts SET
			total     = total     - 1,
			seeds     = seeds     - seed_delta_new,
			instances = instances - inst_delta_new
			WHERE owner = OLD.owner;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Owner NFT count missing for %', OLD.owner;
		END IF;

		INSERT INTO owner_nft_counts (owner, total, seeds, instances)
		VALUES (NEW.owner, 1, seed_delta_new, inst_delta_new)
		ON CONFLICT (owner) DO UPDATE SET
			total     = owner_nft_counts.total     + 1,
			seeds     = owner_nft_counts.seeds     + seed_delta_new,
			instances = owner_nft_counts.instances + inst_delta_new;

		RETURN NEW;
	END IF;

	RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintain_nft_counters ON nfts;
CREATE TRIGGER trg_maintain_nft_counters
	AFTER INSERT OR DELETE OR UPDATE OF owner ON nfts
	FOR EACH ROW
	EXECUTE FUNCTION maintain_nft_counters();

-- Per-collection instance cap. `collections.max_instances = 0` means the
-- creator opted out of a per-collection cap (unlimited, subject only to
-- per-creator limits). A positive value is the hard ceiling across every
-- seed in that collection. The handler `bulk_distribute` enforces this
-- app-side, but a buggy handler, a future code path that bypasses the
-- usual flow, or ad-hoc SQL could breach the cap silently — the trigger
-- is the DB backstop. We read the materialized counter from
-- `collection_stats`; within a single tx the post-insert counter update
-- is visible to the next BEFORE trigger, so sequential bulk_distribute
-- inserts each see the running total.
CREATE OR REPLACE FUNCTION enforce_max_instances()
RETURNS TRIGGER AS $$
DECLARE
	cap INTEGER;
	current_count INTEGER;
BEGIN
	IF NEW.nft_type = 'instance' THEN
		SELECT max_instances INTO cap
			FROM collections
			WHERE id = NEW.collection_id;
		IF cap IS NOT NULL AND cap > 0 THEN
			SELECT COALESCE(instances, 0) INTO current_count
				FROM collection_stats
				WHERE collection_id = NEW.collection_id;
			IF COALESCE(current_count, 0) + 1 > cap THEN
				RAISE EXCEPTION
					'nfts.instance cap exceeded for collection %: current=% + 1 > max_instances=%',
					NEW.collection_id, COALESCE(current_count, 0), cap;
			END IF;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_max_instances ON nfts;
CREATE TRIGGER trg_enforce_max_instances
	BEFORE INSERT ON nfts
	FOR EACH ROW
	EXECUTE FUNCTION enforce_max_instances();

-- `nfts.collection_id` on an instance row is a deliberate desnormalization —
-- we keep it so ownership/collection queries stay linear without a JOIN to
-- the parent seed. The price of that cache is that a buggy handler (or a
-- rogue INSERT) could write an instance whose `collection_id` disagrees
-- with its parent seed's `collection_id`, silently forking the state_root
-- projection between replicas. This trigger is the DB-level backstop:
-- before persisting any instance row, we look up the parent seed and
-- reject the INSERT if the collection_ids do not match. Seeds are skipped
-- (seed_id IS NULL). UPDATE is already blocked by the immutability
-- triggers on collection_id and seed_id, so firing on INSERT is enough.
CREATE OR REPLACE FUNCTION enforce_instance_collection_matches_seed()
RETURNS TRIGGER AS $$
DECLARE
	seed_collection_id TEXT;
BEGIN
	IF NEW.seed_id IS NOT NULL THEN
		SELECT collection_id INTO seed_collection_id
			FROM nfts
			WHERE id = NEW.seed_id;
		-- If seed not found the FK will raise after; no point double-reporting.
		IF seed_collection_id IS NOT NULL
		   AND NEW.collection_id IS DISTINCT FROM seed_collection_id THEN
			RAISE EXCEPTION
				'nfts.collection_id mismatch: instance % claims collection %, parent seed % belongs to collection %',
				NEW.id, NEW.collection_id, NEW.seed_id, seed_collection_id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_instance_collection_matches_seed ON nfts;
CREATE TRIGGER trg_enforce_instance_collection_matches_seed
	BEFORE INSERT ON nfts
	FOR EACH ROW
	EXECUTE FUNCTION enforce_instance_collection_matches_seed();

-- `schema_versions` is the append-only hash chain recording every set_schema
-- operation per collection (prev_hash linking each row to its predecessor).
-- Application code only INSERTs. Any UPDATE silently invalidates the chain
-- from that row forward, and the corruption is invisible until a future
-- schema audit recomputes hashes. Block UPDATE entirely — DELETE stays
-- allowed because archiveCollection relies on ON DELETE CASCADE from
-- `collections` to tear down versioned rows as part of a full collection
-- teardown.

CREATE OR REPLACE FUNCTION prevent_schema_versions_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'schema_versions is append-only (collection_id=%, version=%)',
		OLD.collection_id, OLD.version;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_schema_versions_mutation ON schema_versions;
CREATE TRIGGER trg_prevent_schema_versions_mutation
	BEFORE UPDATE ON schema_versions
	FOR EACH ROW
	EXECUTE FUNCTION prevent_schema_versions_mutation();

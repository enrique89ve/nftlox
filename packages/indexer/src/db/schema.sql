-- NFTLox Indexer Schema (testnet — clean rebuild)

-- ============ ENUMS ============

DO $$ BEGIN
	CREATE TYPE nft_kind AS ENUM ('seed', 'instance', 'replica');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE nft_status AS ENUM ('active', 'listed', 'lent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============ TABLES ============

-- Sync state (singleton row)
CREATE TABLE IF NOT EXISTS sync_state (
	id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_block BIGINT NOT NULL DEFAULT 0,
	genesis_block BIGINT NOT NULL DEFAULT 0,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sync_state (last_block) VALUES (0) ON CONFLICT (id) DO NOTHING;

-- Collections
CREATE TABLE IF NOT EXISTS collections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	symbol VARCHAR(10) NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,9}$'),
	creator TEXT NOT NULL,
	total_potential INTEGER NOT NULL DEFAULT 0,
	description TEXT,
	image_url TEXT,
	external_url TEXT,
	transferable BOOLEAN NOT NULL DEFAULT TRUE,
	burnable BOOLEAN NOT NULL DEFAULT TRUE,
	replicable BOOLEAN NOT NULL DEFAULT TRUE,
	royalty_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
	royalty_recipient TEXT,
	schema JSONB,
	schema_version INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NFTs (unified: seeds, instances, replicas)
CREATE TABLE IF NOT EXISTS nfts (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL REFERENCES collections(id),
	nft_type nft_kind NOT NULL,
	status nft_status NOT NULL DEFAULT 'active',
	edition INTEGER NOT NULL DEFAULT 1,
	owner TEXT NOT NULL,
	origin_dna TEXT,
	instance_dna TEXT,
	name TEXT NOT NULL,
	image_url TEXT,
	max_replicas INTEGER NOT NULL DEFAULT 1 CHECK (max_replicas >= 0),
	distributed INTEGER NOT NULL DEFAULT 0 CHECK (distributed >= 0),
	reserved_supply INTEGER NOT NULL DEFAULT 0,
	supply_exhausted BOOLEAN GENERATED ALWAYS AS (max_replicas > 0 AND (distributed + reserved_supply) >= max_replicas) STORED,
	seed_id TEXT REFERENCES nfts(id) ON DELETE SET NULL,
	instance_number INTEGER,
	original_id TEXT REFERENCES nfts(id) ON DELETE SET NULL,
	immutable_data JSONB,
	data_operation_id TEXT,
	data_hash TEXT,
	schema_version INTEGER,
	previous_owner TEXT,
	owner_operation_id TEXT NOT NULL,
	listing_id TEXT,
	listing_tx_id TEXT,
	listing_price NUMERIC(18,3),
	listing_currency TEXT,
	listing_expires_at TIMESTAMPTZ,
	listing_marketplace TEXT,
	created_operation_id TEXT NOT NULL,
	created_block_num BIGINT NOT NULL,
	created_tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
	operation_id TEXT NOT NULL
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

-- Confirmed operations (append-only tracking of successful handler executions)
-- Enables per-operation status lookups and stores the immutable NFT IDs affected
-- by that specific protocol operation.
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
	UNIQUE (nft_id, listing_id, tx_id)
);

-- ============ OWNER NFT COUNTS ============

CREATE TABLE IF NOT EXISTS owner_nft_counts (
	owner TEXT PRIMARY KEY,
	total INT NOT NULL DEFAULT 0 CHECK (total >= 0),
	seeds INT NOT NULL DEFAULT 0 CHECK (seeds >= 0),
	instances INT NOT NULL DEFAULT 0 CHECK (instances >= 0),
	replicas INT NOT NULL DEFAULT 0 CHECK (replicas >= 0)
);

-- ============ COLLECTION STATS (denormalized) ============

CREATE TABLE IF NOT EXISTS collection_stats (
	collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
	total INT NOT NULL DEFAULT 0,
	seeds INT NOT NULL DEFAULT 0,
	instances INT NOT NULL DEFAULT 0,
	replicas INT NOT NULL DEFAULT 0,
	listed INT NOT NULL DEFAULT 0,
	burned INT NOT NULL DEFAULT 0
);

-- ============ MULTISIG LOCKS ============

CREATE TABLE IF NOT EXISTS multisig_locks (
	nft_id TEXT PRIMARY KEY,
	buyer TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multisig_locks_expires ON multisig_locks(expires_at);

-- ============ INDEXES ============

-- Collections
CREATE INDEX IF NOT EXISTS idx_collections_creator ON collections(creator);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_creator_symbol ON collections(creator, symbol);
CREATE INDEX IF NOT EXISTS idx_collections_symbol ON collections(symbol);
CREATE INDEX IF NOT EXISTS idx_collections_status ON collections(status, created_at DESC);

-- NFTs
CREATE INDEX IF NOT EXISTS idx_nfts_collection ON nfts(collection_id);
CREATE INDEX IF NOT EXISTS idx_nfts_owner_created ON nfts(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_seed_instances ON nfts(seed_id, instance_number) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_seed_tx ON nfts(seed_id, created_tx_id) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_created_operation_id ON nfts(created_operation_id);
CREATE INDEX IF NOT EXISTS idx_nfts_owner_operation_id ON nfts(owner_operation_id);
CREATE INDEX IF NOT EXISTS idx_nfts_seed_created_operation ON nfts(seed_id, created_operation_id) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_owner_type_status ON nfts(owner, nft_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_owner_active_instances ON nfts(owner, created_at DESC) WHERE nft_type = 'instance' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_nfts_owner_active_seeds ON nfts(owner, collection_id) WHERE nft_type = 'seed' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_nfts_seeds_available ON nfts(collection_id, distributed) WHERE nft_type = 'seed' AND supply_exhausted = FALSE;
CREATE INDEX IF NOT EXISTS idx_nfts_collection_type ON nfts(collection_id, nft_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_listed ON nfts(listing_price, listing_currency) WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_nfts_listed_recent ON nfts(created_at DESC) WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_nfts_listed_marketplace ON nfts(listing_marketplace) WHERE status = 'listed' AND listing_marketplace IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_listing_id ON nfts(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_listing_expires ON nfts(listing_expires_at) WHERE status = 'listed' AND listing_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_schema_version ON nfts(collection_id, schema_version);

-- Invalid operations
CREATE INDEX IF NOT EXISTS idx_invalid_block ON invalid_operations(block_num);
CREATE INDEX IF NOT EXISTS idx_invalid_tx ON invalid_operations(tx_id) WHERE tx_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invalid_signer ON invalid_operations(signer) WHERE signer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invalid_op_id ON invalid_operations(operation_id) WHERE operation_id IS NOT NULL;

-- Orphaned buys
CREATE INDEX IF NOT EXISTS idx_orphaned_buys_buyer ON orphaned_buys(buyer);
CREATE INDEX IF NOT EXISTS idx_orphaned_buys_tx ON orphaned_buys(tx_id);
CREATE INDEX IF NOT EXISTS idx_orphaned_buys_op_id ON orphaned_buys(operation_id) WHERE operation_id IS NOT NULL;

-- Allowances
CREATE INDEX IF NOT EXISTS idx_nft_allowances_owner ON nft_allowances(owner);
CREATE INDEX IF NOT EXISTS idx_nft_allowances_spender ON nft_allowances(approved_spender);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_spender ON collection_allowances(spender);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_collection ON collection_allowances(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_active ON collection_allowances(owner, collection_id) WHERE approved = TRUE;

-- Data operators
CREATE INDEX IF NOT EXISTS idx_data_operators_operator ON data_operators(operator);
CREATE INDEX IF NOT EXISTS idx_data_operators_collection ON data_operators(collection_id);

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
CREATE INDEX IF NOT EXISTS idx_sales_currency_date ON sales(currency, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_block ON sales(block_num);

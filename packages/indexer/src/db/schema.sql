-- NFTLox Indexer Schema (idempotent — safe to re-run)

-- ============ ENUMS ============

DO $$ BEGIN
	CREATE TYPE nft_kind AS ENUM ('seed', 'instance', 'replica');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE nft_status AS ENUM ('active', 'listed', 'burned', 'lent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE pack_status AS ENUM ('active', 'paused', 'depleted');
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
	json_id TEXT,
	name TEXT NOT NULL,
	symbol TEXT NOT NULL,
	creator TEXT NOT NULL,
	total_potential INTEGER NOT NULL DEFAULT 0,
	origin_dna TEXT,
	description TEXT,
	image_url TEXT,
	external_url TEXT,
	transferable BOOLEAN NOT NULL DEFAULT TRUE,
	burnable BOOLEAN NOT NULL DEFAULT TRUE,
	replicable BOOLEAN NOT NULL DEFAULT TRUE,
	royalty_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
	royalty_recipient TEXT,
	schema JSONB,
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
	unique_access_key TEXT,
	birth_block BIGINT NOT NULL DEFAULT 0,
	birth_tx TEXT NOT NULL DEFAULT '',
	minted_by TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	image_url TEXT,
	image_hash TEXT,
	max_replicas INTEGER NOT NULL DEFAULT 1,
	distributed INTEGER NOT NULL DEFAULT 0,
	supply_exhausted BOOLEAN GENERATED ALWAYS AS (max_replicas > 0 AND distributed >= max_replicas) STORED,
	seed_id TEXT REFERENCES nfts(id),
	instance_number INTEGER,
	original_id TEXT REFERENCES nfts(id),
	immutable_data JSONB,
	immutable_data_hash TEXT,
	mutable_data JSONB,
	mutable_data_hash TEXT,
	mutable_data_tx TEXT,
	mutable_data_block BIGINT,
	owner_data JSONB,
	owner_data_hash TEXT,
	owner_data_tx TEXT,
	owner_data_block BIGINT,
	burned_by TEXT,
	burned_at_block BIGINT,
	listing_id TEXT,
	listing_tx_id TEXT,
	listing_price NUMERIC(18,3),
	listing_currency TEXT,
	listing_expires_at TIMESTAMPTZ,
	listing_marketplace TEXT,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invalid operations (audit trail)
CREATE TABLE IF NOT EXISTS invalid_operations (
	id BIGSERIAL PRIMARY KEY,
	block_num BIGINT NOT NULL,
	tx_id TEXT,
	signer TEXT,
	action TEXT,
	reason TEXT NOT NULL,
	raw_payload JSONB,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Orphaned buys
CREATE TABLE IF NOT EXISTS orphaned_buys (
	id BIGSERIAL PRIMARY KEY,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	buyer TEXT NOT NULL,
	nft_id TEXT,
	reason TEXT NOT NULL,
	transfers JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Packs
CREATE TABLE IF NOT EXISTS packs (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL REFERENCES collections(id),
	creator TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	image_url TEXT,
	drop_table JSONB NOT NULL,
	items_per_pack INTEGER NOT NULL DEFAULT 1,
	price_amount NUMERIC(18,3),
	price_currency TEXT,
	max_supply INTEGER NOT NULL DEFAULT 0,
	current_supply INTEGER NOT NULL DEFAULT 0,
	total_opened INTEGER NOT NULL DEFAULT 0,
	status pack_status NOT NULL DEFAULT 'active',
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_pack_balances (
	account TEXT NOT NULL,
	pack_id TEXT NOT NULL REFERENCES packs(id),
	balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
	PRIMARY KEY (account, pack_id)
);

-- ============ ALLOWANCE TABLES ============

-- Pack allowances (ERC-20 style)
CREATE TABLE IF NOT EXISTS pack_allowances (
	owner TEXT NOT NULL,
	spender TEXT NOT NULL,
	pack_id TEXT NOT NULL REFERENCES packs(id),
	quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (owner, spender, pack_id)
);

-- NFT allowances (ERC-721 style)
CREATE TABLE IF NOT EXISTS nft_allowances (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id),
	owner TEXT NOT NULL,
	approved_spender TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Collection allowances (setApprovalForAll style)
CREATE TABLE IF NOT EXISTS collection_allowances (
	owner TEXT NOT NULL,
	spender TEXT NOT NULL,
	collection_id TEXT NOT NULL REFERENCES collections(id),
	approved BOOLEAN NOT NULL DEFAULT TRUE,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (owner, spender, collection_id)
);

-- ============ DATA OPERATORS ============

CREATE TABLE IF NOT EXISTS data_operators (
	collection_id TEXT NOT NULL REFERENCES collections(id),
	operator TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (collection_id, operator)
);

-- ============ LENDING ============

CREATE TABLE IF NOT EXISTS nft_loans (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id),
	lender TEXT NOT NULL,
	borrower TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============ OWNER NFT COUNTS ============

CREATE TABLE IF NOT EXISTS owner_nft_counts (
	owner TEXT PRIMARY KEY,
	total INT NOT NULL DEFAULT 0,
	seeds INT NOT NULL DEFAULT 0,
	instances INT NOT NULL DEFAULT 0,
	replicas INT NOT NULL DEFAULT 0
);

-- ============ INDEXES ============

CREATE INDEX IF NOT EXISTS idx_collections_creator ON collections(creator);
CREATE INDEX IF NOT EXISTS idx_collections_symbol ON collections(symbol);

CREATE INDEX IF NOT EXISTS idx_nfts_collection ON nfts(collection_id);
CREATE INDEX IF NOT EXISTS idx_nfts_owner_created ON nfts(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_seed_instances ON nfts(seed_id, instance_number) WHERE seed_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_owner_active_instances ON nfts(owner, created_at DESC) WHERE nft_type = 'instance' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_nfts_owner_active_seeds ON nfts(owner, collection_id) WHERE nft_type = 'seed' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_nfts_seeds_available ON nfts(collection_id, distributed) WHERE nft_type = 'seed' AND supply_exhausted = FALSE;
CREATE INDEX IF NOT EXISTS idx_nfts_collection_type ON nfts(collection_id, nft_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfts_listed ON nfts(listing_price, listing_currency) WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_nfts_listed_recent ON nfts(created_at DESC) WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_nfts_listed_marketplace ON nfts(listing_marketplace) WHERE status = 'listed' AND listing_marketplace IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_listing_id ON nfts(listing_id) WHERE listing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nfts_immutable_data ON nfts USING GIN (immutable_data) WHERE immutable_data IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfts_mutable_data ON nfts USING GIN (mutable_data) WHERE mutable_data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invalid_block ON invalid_operations(block_num);

CREATE INDEX IF NOT EXISTS idx_orphaned_buys_buyer ON orphaned_buys(buyer);
CREATE INDEX IF NOT EXISTS idx_orphaned_buys_tx ON orphaned_buys(tx_id);

CREATE INDEX IF NOT EXISTS idx_packs_collection ON packs(collection_id);
CREATE INDEX IF NOT EXISTS idx_packs_creator ON packs(creator);
CREATE INDEX IF NOT EXISTS idx_packs_status ON packs(status);
CREATE INDEX IF NOT EXISTS idx_pack_balances_account ON user_pack_balances(account);
CREATE INDEX IF NOT EXISTS idx_pack_balances_pack ON user_pack_balances(pack_id);
CREATE INDEX IF NOT EXISTS idx_pack_balances_positive ON user_pack_balances(account, pack_id) WHERE balance > 0;

CREATE INDEX IF NOT EXISTS idx_pack_allowances_spender ON pack_allowances(spender);
CREATE INDEX IF NOT EXISTS idx_pack_allowances_pack ON pack_allowances(pack_id);
CREATE INDEX IF NOT EXISTS idx_pack_allowances_positive ON pack_allowances(owner, pack_id) WHERE quantity > 0;
CREATE INDEX IF NOT EXISTS idx_nft_allowances_owner ON nft_allowances(owner);
CREATE INDEX IF NOT EXISTS idx_nft_allowances_spender ON nft_allowances(approved_spender);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_spender ON collection_allowances(spender);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_collection ON collection_allowances(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_allowances_active ON collection_allowances(owner, collection_id) WHERE approved = TRUE;

CREATE INDEX IF NOT EXISTS idx_data_operators_operator ON data_operators(operator);
CREATE INDEX IF NOT EXISTS idx_data_operators_collection ON data_operators(collection_id);

CREATE INDEX IF NOT EXISTS idx_nft_loans_lender ON nft_loans(lender);
CREATE INDEX IF NOT EXISTS idx_nft_loans_borrower ON nft_loans(borrower);

-- ============ TRIGGER FUNCTION ============

CREATE OR REPLACE FUNCTION update_owner_nft_counts() RETURNS TRIGGER AS $$
DECLARE
	old_counted BOOLEAN;
	new_counted BOOLEAN;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status != 'burned' THEN
			INSERT INTO owner_nft_counts (owner, total, seeds, instances, replicas)
			VALUES (
				NEW.owner, 1,
				(NEW.nft_type = 'seed')::int,
				(NEW.nft_type = 'instance')::int,
				(NEW.nft_type = 'replica')::int
			)
			ON CONFLICT (owner) DO UPDATE SET
				total = owner_nft_counts.total + 1,
				seeds = owner_nft_counts.seeds + (NEW.nft_type = 'seed')::int,
				instances = owner_nft_counts.instances + (NEW.nft_type = 'instance')::int,
				replicas = owner_nft_counts.replicas + (NEW.nft_type = 'replica')::int;
		END IF;
		RETURN NEW;

	ELSIF TG_OP = 'UPDATE' THEN
		old_counted := (OLD.status != 'burned');
		new_counted := (NEW.status != 'burned');

		IF OLD.owner = NEW.owner AND OLD.nft_type = NEW.nft_type AND old_counted = new_counted THEN
			RETURN NEW;
		END IF;

		IF old_counted THEN
			UPDATE owner_nft_counts SET
				total = total - 1,
				seeds = seeds - (OLD.nft_type = 'seed')::int,
				instances = instances - (OLD.nft_type = 'instance')::int,
				replicas = replicas - (OLD.nft_type = 'replica')::int
			WHERE owner = OLD.owner;
		END IF;

		IF new_counted THEN
			INSERT INTO owner_nft_counts (owner, total, seeds, instances, replicas)
			VALUES (
				NEW.owner, 1,
				(NEW.nft_type = 'seed')::int,
				(NEW.nft_type = 'instance')::int,
				(NEW.nft_type = 'replica')::int
			)
			ON CONFLICT (owner) DO UPDATE SET
				total = owner_nft_counts.total + 1,
				seeds = owner_nft_counts.seeds + (NEW.nft_type = 'seed')::int,
				instances = owner_nft_counts.instances + (NEW.nft_type = 'instance')::int,
				replicas = owner_nft_counts.replicas + (NEW.nft_type = 'replica')::int;
		END IF;
		RETURN NEW;

	ELSIF TG_OP = 'DELETE' THEN
		IF OLD.status != 'burned' THEN
			UPDATE owner_nft_counts SET
				total = total - 1,
				seeds = seeds - (OLD.nft_type = 'seed')::int,
				instances = instances - (OLD.nft_type = 'instance')::int,
				replicas = replicas - (OLD.nft_type = 'replica')::int
			WHERE owner = OLD.owner;
		END IF;
		RETURN OLD;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_owner_nft_counts ON nfts;
CREATE TRIGGER trg_owner_nft_counts
	AFTER INSERT OR UPDATE OF owner, status, nft_type OR DELETE
	ON nfts
	FOR EACH ROW
	EXECUTE FUNCTION update_owner_nft_counts();

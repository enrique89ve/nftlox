-- NFTLox Indexer Schema

-- Sync state (singleton row)
CREATE TABLE sync_state (
	id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	last_block BIGINT NOT NULL DEFAULT 0,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sync_state (last_block) VALUES (0);

-- Collections
CREATE TABLE collections (
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
	royalty_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
	royalty_recipient TEXT,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NFTs (unified: seeds, instances, replicas)
CREATE TYPE nft_kind AS ENUM ('seed', 'instance', 'replica');
CREATE TYPE nft_status AS ENUM ('active', 'listed', 'burned', 'lent');

CREATE TABLE nfts (
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
	tags TEXT[],
	custom_data JSONB,
	operator_data JSONB,
	listing_price NUMERIC(18,3),
	listing_currency TEXT,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- History events
CREATE TABLE history_events (
	id BIGSERIAL PRIMARY KEY,
	nft_id TEXT NOT NULL,
	collection_id TEXT,
	event_type TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	timestamp TIMESTAMPTZ NOT NULL,
	from_account TEXT,
	to_account TEXT,
	price_amount NUMERIC(18,3),
	price_currency TEXT,
	payload JSONB,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE(block_num, tx_id, event_type, nft_id)
);

-- Offers
CREATE TYPE offer_status AS ENUM ('active', 'accepted', 'rejected', 'expired');

CREATE TABLE offers (
	id TEXT PRIMARY KEY,
	nft_id TEXT NOT NULL REFERENCES nfts(id),
	offerer TEXT NOT NULL,
	price_amount NUMERIC(18,3) NOT NULL,
	price_currency TEXT NOT NULL,
	status offer_status NOT NULL DEFAULT 'active',
	expires_at TIMESTAMPTZ,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	resolved_at TIMESTAMPTZ,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invalid operations (audit trail)
CREATE TABLE invalid_operations (
	id BIGSERIAL PRIMARY KEY,
	block_num BIGINT NOT NULL,
	tx_id TEXT,
	signer TEXT,
	action TEXT,
	reason TEXT NOT NULL,
	raw_payload JSONB,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices
CREATE INDEX idx_collections_creator ON collections(creator);
CREATE INDEX idx_collections_symbol ON collections(symbol);

-- Base indexes
CREATE INDEX idx_nfts_collection ON nfts(collection_id);
CREATE INDEX idx_nfts_owner_created ON nfts(owner, created_at DESC);

-- Partial: seed children ordered by instance_number (queryNfts by:seed)
CREATE INDEX idx_nfts_seed_instances ON nfts(seed_id, instance_number)
	WHERE seed_id IS NOT NULL;

-- Partial: active instances per owner (user inventory — hottest query)
CREATE INDEX idx_nfts_owner_active_instances ON nfts(owner, created_at DESC)
	WHERE nft_type = 'instance' AND status = 'active';

-- Partial: active seeds per owner (seed management)
CREATE INDEX idx_nfts_owner_active_seeds ON nfts(owner, collection_id)
	WHERE nft_type = 'seed' AND status = 'active';

-- Partial: seeds with available supply (Norse: "which seeds can still distribute?")
CREATE INDEX idx_nfts_seeds_available ON nfts(collection_id, distributed)
	WHERE nft_type = 'seed' AND supply_exhausted = FALSE;

-- Partial: collection browsing by type (queryNfts by:collection)
CREATE INDEX idx_nfts_collection_type ON nfts(collection_id, nft_type, created_at DESC);

-- Partial: marketplace listings sorted by price
CREATE INDEX idx_nfts_listed ON nfts(listing_price, listing_currency)
	WHERE status = 'listed';

-- Partial: marketplace listings sorted by recent (default sort)
CREATE INDEX idx_nfts_listed_recent ON nfts(created_at DESC)
	WHERE status = 'listed';

-- History: base indexes
CREATE INDEX idx_history_nft ON history_events(nft_id);
CREATE INDEX idx_history_block ON history_events(block_num);
CREATE INDEX idx_history_type ON history_events(event_type);

-- History: user activity (getUserActivity — OR query needs both columns indexed)
CREATE INDEX idx_history_from ON history_events(from_account, id DESC)
	WHERE from_account IS NOT NULL;
CREATE INDEX idx_history_to ON history_events(to_account, id DESC)
	WHERE to_account IS NOT NULL;

-- History: recent sales with sort (getRecentSales)
CREATE INDEX idx_history_sales ON history_events(block_num DESC, id DESC)
	WHERE event_type = 'buy';

CREATE INDEX idx_offers_nft ON offers(nft_id);
CREATE INDEX idx_offers_offerer ON offers(offerer);
CREATE INDEX idx_offers_status ON offers(status);

CREATE INDEX idx_invalid_block ON invalid_operations(block_num);

-- ============ PACK TABLES ============

CREATE TYPE pack_status AS ENUM ('active', 'paused', 'depleted');

CREATE TABLE packs (
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

CREATE TABLE user_pack_balances (
	account TEXT NOT NULL,
	pack_id TEXT NOT NULL REFERENCES packs(id),
	balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
	PRIMARY KEY (account, pack_id)
);

CREATE TABLE pack_history_events (
	id BIGSERIAL PRIMARY KEY,
	pack_id TEXT NOT NULL REFERENCES packs(id),
	collection_id TEXT,
	event_type TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	timestamp TIMESTAMPTZ NOT NULL,
	from_account TEXT,
	to_account TEXT,
	quantity INTEGER,
	price_amount NUMERIC(18,3),
	price_currency TEXT,
	payload JSONB,
	indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE(block_num, tx_id, event_type, pack_id, from_account)
);

CREATE INDEX idx_packs_collection ON packs(collection_id);
CREATE INDEX idx_packs_creator ON packs(creator);
CREATE INDEX idx_packs_status ON packs(status);
CREATE INDEX idx_pack_balances_account ON user_pack_balances(account);
CREATE INDEX idx_pack_balances_pack ON user_pack_balances(pack_id);
CREATE INDEX idx_pack_balances_positive ON user_pack_balances(account, pack_id)
	WHERE balance > 0;
CREATE INDEX idx_pack_history_pack ON pack_history_events(pack_id);
CREATE INDEX idx_pack_history_block ON pack_history_events(block_num);
CREATE INDEX idx_pack_history_type ON pack_history_events(event_type);

-- ============ ALLOWANCE TABLES (Approve & TransferFrom) ============

-- Pack allowances (ERC-20 style): fungible spending limits
CREATE TABLE pack_allowances (
	owner TEXT NOT NULL,
	spender TEXT NOT NULL,
	pack_id TEXT NOT NULL REFERENCES packs(id),
	quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (owner, spender, pack_id)
);

-- NFT allowances (ERC-721 style): one approved spender per NFT
CREATE TABLE nft_allowances (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id),
	owner TEXT NOT NULL,
	approved_spender TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Collection allowances (ERC-721 setApprovalForAll style)
CREATE TABLE collection_allowances (
	owner TEXT NOT NULL,
	spender TEXT NOT NULL,
	collection_id TEXT NOT NULL REFERENCES collections(id),
	approved BOOLEAN NOT NULL DEFAULT TRUE,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (owner, spender, collection_id)
);

CREATE INDEX idx_pack_allowances_spender ON pack_allowances(spender);
CREATE INDEX idx_pack_allowances_pack ON pack_allowances(pack_id);
CREATE INDEX idx_pack_allowances_positive ON pack_allowances(owner, pack_id)
	WHERE quantity > 0;

CREATE INDEX idx_nft_allowances_owner ON nft_allowances(owner);
CREATE INDEX idx_nft_allowances_spender ON nft_allowances(approved_spender);

CREATE INDEX idx_collection_allowances_spender ON collection_allowances(spender);
CREATE INDEX idx_collection_allowances_collection ON collection_allowances(collection_id);
CREATE INDEX idx_collection_allowances_active ON collection_allowances(owner, collection_id)
	WHERE approved = TRUE;

-- ============ DATA OPERATORS TABLE ============

CREATE TABLE data_operators (
	collection_id TEXT NOT NULL REFERENCES collections(id),
	operator TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (collection_id, operator)
);

CREATE INDEX idx_data_operators_operator ON data_operators(operator);
CREATE INDEX idx_data_operators_collection ON data_operators(collection_id);

-- ============ LENDING TABLE ============

CREATE TABLE nft_loans (
	nft_id TEXT PRIMARY KEY REFERENCES nfts(id),
	lender TEXT NOT NULL,
	borrower TEXT NOT NULL,
	block_num BIGINT NOT NULL,
	tx_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_nft_loans_lender ON nft_loans(lender);
CREATE INDEX idx_nft_loans_borrower ON nft_loans(borrower);

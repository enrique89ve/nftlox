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
CREATE TYPE nft_status AS ENUM ('active', 'listed', 'burned');

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
	seed_id TEXT REFERENCES nfts(id),
	instance_number INTEGER,
	original_id TEXT REFERENCES nfts(id),
	tags TEXT[],
	custom_data JSONB,
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

CREATE INDEX idx_nfts_collection ON nfts(collection_id);
CREATE INDEX idx_nfts_owner ON nfts(owner);
CREATE INDEX idx_nfts_status ON nfts(status);
CREATE INDEX idx_nfts_seed ON nfts(seed_id) WHERE seed_id IS NOT NULL;
CREATE INDEX idx_nfts_type ON nfts(nft_type);
CREATE INDEX idx_nfts_listed ON nfts(status, listing_price) WHERE status = 'listed';

CREATE INDEX idx_history_nft ON history_events(nft_id);
CREATE INDEX idx_history_block ON history_events(block_num);
CREATE INDEX idx_history_type ON history_events(event_type);

CREATE INDEX idx_offers_nft ON offers(nft_id);
CREATE INDEX idx_offers_offerer ON offers(offerer);
CREATE INDEX idx_offers_status ON offers(status);

CREATE INDEX idx_invalid_block ON invalid_operations(block_num);

// NFTLox Indexer API Client
// Portable client using only fetch() — works in browser, Bun, and Node.

// ============ ERROR ============

export class IndexerError extends Error {
	status: number;
	body: string;

	constructor(status: number, body: string) {
		super(`Indexer error ${status}: ${body}`);
		this.name = "IndexerError";
		this.status = status;
		this.body = body;
	}
}

// ============ RESPONSE TYPES ============

export interface SyncStatus {
	lastBlock: number;
	headBlock: number;
	blocksBehind: number;
	syncing: boolean;
}

export interface HealthStatus {
	status: string;
	db: string;
	sync: string;
	inSync: boolean;
	lastBlock: number;
	headBlock: number;
	blocksBehind: number;
	secondsSinceUpdate: number;
}

export interface ProtocolStats {
	total_collections: number;
	total_nfts: number;
	total_seeds: number;
	total_instances: number;
	total_replicas: number;
	total_listed: number;
	total_burned: number;
	unique_owners: number;
	total_events: number;
	total_sales: number;
	active_offers: number;
	invalid_ops: number;
}

export interface IndexerCollection {
	id: string;
	name: string;
	symbol: string;
	creator: string;
	total_potential: number;
	origin_dna: string | null;
	description: string | null;
	image_url: string | null;
	external_url: string | null;
	transferable: boolean;
	burnable: boolean;
	royalty_pct: number;
	royalty_recipient: string | null;
	seed_count: number;
	instance_count: number;
	block_num: number;
	tx_id: string;
	created_at: string;
}

export interface CollectionStats {
	total_seeds: number;
	total_instances: number;
	total_replicas: number;
	total_listed: number;
	total_burned: number;
	unique_owners: number;
	floor_price: number | null;
}

export interface IndexerNft {
	id: string;
	collection_id: string;
	nft_type: "seed" | "instance" | "replica";
	status: "active" | "listed" | "burned" | "lent";
	owner: string;
	name: string;
	description: string | null;
	image_url: string | null;
	image_hash: string | null;
	origin_dna: string | null;
	instance_dna: string | null;
	unique_access_key: string | null;
	edition: number;
	seed_id: string | null;
	instance_number: number | null;
	original_id: string | null;
	max_replicas: number;
	distributed: number;
	minted_by: string | null;
	listing_price: string | null;
	listing_currency: string | null;
	tags: string[] | null;
	custom_data: Record<string, unknown> | null;
	block_num: number;
	tx_id: string;
	created_at: string;
}

export interface IndexerOffer {
	id: string;
	nft_id: string;
	offerer: string;
	price_amount: string;
	price_currency: string;
	status: "active" | "accepted" | "rejected" | "expired";
	expires_at: string | null;
	block_num: number;
	tx_id: string;
	created_at: string;
}

export interface IndexerPack {
	id: string;
	collection_id: string;
	creator: string;
	name: string;
	description: string | null;
	image_url: string | null;
	drop_table: Array<{ seedId: string; weight: number }>;
	items_per_pack: number;
	price_amount: string | null;
	price_currency: string | null;
	max_supply: number;
	current_supply: number;
	total_opened: number;
	status: string;
	block_num: number;
	tx_id: string;
	created_at: string;
}

export interface PackBalance {
	account: string;
	pack_id: string;
	balance: number;
	name: string;
	description: string | null;
	image_url: string | null;
	collection_id: string;
	items_per_pack: number;
	price_amount: string | null;
	price_currency: string | null;
	max_supply: number;
	current_supply: number;
	status: string;
}

export interface IndexerHistoryEvent {
	id: number;
	nft_id: string;
	event_type: string;
	block_num: number;
	tx_id: string;
	timestamp: string;
	from_account: string | null;
	to_account: string | null;
	price_amount: string | null;
	price_currency: string | null;
}

export interface SaleEvent extends IndexerHistoryEvent {
	nft_name: string;
	nft_image_url: string | null;
	collection_id: string;
}

export interface OwnershipRecord {
	from_account: string | null;
	to_account: string | null;
	event_type: string;
	timestamp: string;
	block_num: number;
	tx_id: string;
	price_amount: string | null;
	price_currency: string | null;
}

export interface PackHistoryEvent {
	id: number;
	pack_id: string;
	event_type: string;
	account: string;
	quantity: number;
	block_num: number;
	tx_id: string;
	timestamp: string;
}

// ============ INTERNAL HELPERS ============

type QueryParams = { [key: string]: string | number | boolean | undefined | null };

async function get<T>(baseUrl: string, path: string, params?: QueryParams): Promise<T> {
	const url = new URL(path, baseUrl);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}
	}
	const response = await fetch(url.toString());
	if (!response.ok) {
		throw new IndexerError(response.status, await response.text());
	}
	return response.json() as Promise<T>;
}

// ============ CLIENT FACTORY ============

export interface IndexerClient {
	// Status
	getStatus(): Promise<SyncStatus>;
	getHealth(): Promise<HealthStatus>;
	getStats(): Promise<ProtocolStats>;

	// Collections
	getCollections(params?: { limit?: number; offset?: number }): Promise<IndexerCollection[]>;
	getCollection(id: string): Promise<IndexerCollection>;
	getCollectionNfts(id: string, params?: { type?: string; limit?: number; offset?: number }): Promise<IndexerNft[]>;
	getCollectionStats(id: string): Promise<CollectionStats>;

	// NFTs
	getNft(id: string): Promise<IndexerNft>;
	getNftHistory(id: string, params?: { limit?: number; offset?: number; cursor?: number }): Promise<IndexerHistoryEvent[]>;
	getNftOwnership(id: string): Promise<OwnershipRecord[]>;
	getNftInstances(id: string, params?: { limit?: number; offset?: number }): Promise<IndexerNft[]>;
	getNftOffers(id: string, params?: { status?: string; limit?: number; offset?: number }): Promise<IndexerOffer[]>;

	// Users
	getUserNfts(username: string, params?: { status?: string; type?: string; limit?: number; offset?: number }): Promise<IndexerNft[]>;
	getUserCollections(username: string, params?: { limit?: number; offset?: number }): Promise<IndexerCollection[]>;
	getUserActivity(username: string, params?: { limit?: number; offset?: number; cursor?: number }): Promise<IndexerHistoryEvent[]>;
	getUserPacks(username: string, params?: { limit?: number; offset?: number }): Promise<PackBalance[]>;

	// Marketplace
	getListings(params?: { sort?: string; currency?: string; limit?: number; offset?: number }): Promise<IndexerNft[]>;
	getRecentSales(params?: { limit?: number; offset?: number; cursor?: number }): Promise<SaleEvent[]>;

	// Packs
	getPacks(params?: { collectionId?: string; limit?: number; offset?: number }): Promise<IndexerPack[]>;
	getPack(id: string): Promise<IndexerPack>;
	getPackHistory(id: string, params?: { limit?: number; offset?: number; cursor?: number }): Promise<PackHistoryEvent[]>;
}

export function createIndexerClient(baseUrl: string): IndexerClient {
	return {
		// ---- Status ----
		getStatus: () => get<SyncStatus>(baseUrl, "/api/status"),
		getHealth: () => get<HealthStatus>(baseUrl, "/api/health"),
		getStats: () => get<ProtocolStats>(baseUrl, "/api/stats"),

		// ---- Collections ----
		getCollections: (params) =>
			get<IndexerCollection[]>(baseUrl, "/api/collections", params),
		getCollection: (id) =>
			get<IndexerCollection>(baseUrl, `/api/collections/${encodeURIComponent(id)}`),
		getCollectionNfts: (id, params) =>
			get<IndexerNft[]>(baseUrl, `/api/collections/${encodeURIComponent(id)}/nfts`, params),
		getCollectionStats: (id) =>
			get<CollectionStats>(baseUrl, `/api/collections/${encodeURIComponent(id)}/stats`),

		// ---- NFTs ----
		getNft: (id) =>
			get<IndexerNft>(baseUrl, `/api/nfts/${encodeURIComponent(id)}`),
		getNftHistory: (id, params) =>
			get<IndexerHistoryEvent[]>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/history`, params),
		getNftOwnership: (id) =>
			get<OwnershipRecord[]>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/ownership`),
		getNftInstances: (id, params) =>
			get<IndexerNft[]>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/instances`, params),
		getNftOffers: (id, params) =>
			get<IndexerOffer[]>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/offers`, params),

		// ---- Users ----
		getUserNfts: (username, params) =>
			get<IndexerNft[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/nfts`, params),
		getUserCollections: (username, params) =>
			get<IndexerCollection[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/collections`, params),
		getUserActivity: (username, params) =>
			get<IndexerHistoryEvent[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/activity`, params),
		getUserPacks: (username, params) =>
			get<PackBalance[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/packs`, params),

		// ---- Marketplace ----
		getListings: (params) =>
			get<IndexerNft[]>(baseUrl, "/api/marketplace/listings", params),
		getRecentSales: (params) =>
			get<SaleEvent[]>(baseUrl, "/api/marketplace/recent-sales", params),

		// ---- Packs ----
		getPacks: (params) =>
			get<IndexerPack[]>(baseUrl, "/api/packs", params),
		getPack: (id) =>
			get<IndexerPack>(baseUrl, `/api/packs/${encodeURIComponent(id)}`),
		getPackHistory: (id, params) =>
			get<PackHistoryEvent[]>(baseUrl, `/api/packs/${encodeURIComponent(id)}/history`, params),
	};
}

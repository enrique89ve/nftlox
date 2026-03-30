// NFTLox Indexer API Client
// Portable client using only fetch() — works in browser, Bun, and Node.

import type { PaymentInfo, MultisigRequest, MultisigResponse } from "./types";

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
	protocolVersion: string;
	protocolId: string;
	nodeAccount: string;
	nodeUrl: string | null;
	multisigEnabled: boolean;
	lastBlock: number;
	headBlock: number;
	blocksBehind: number;
	inSync: boolean;
}

export interface HealthStatus {
	status: string;
	db: string;
	sync: string;
	inSync?: boolean;
	lastBlock?: number;
	headBlock?: number;
	blocksBehind?: number;
	secondsSinceUpdate?: number;
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
	invalid_ops: number;
}

export interface UserNftCounts {
	total: number;
	seeds: number;
	instances: number;
	replicas: number;
}

export interface UserNftsPage {
	nfts: IndexerNftSummary[];
	counts: UserNftCounts;
	offset: number;
	limit: number;
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
	replicable: boolean;
	royalty_pct: number;
	royalty_recipient: string | null;
	json_id: string | null;
	status: "active" | "archived";
	archived_at_block: number | null;
	archived_tx_id: string | null;
	archived_at: string | null;
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

export interface IndexerNftSummary {
	id: string;
	collection_id: string;
	nft_type: "seed" | "instance" | "replica";
	status: "active" | "listed" | "burned" | "lent";
	edition: number;
	owner: string;
	name: string;
	image_url: string | null;
	origin_dna: string | null;
	instance_dna: string | null;
	seed_id: string | null;
	seed_tx_id: string | null;
	instance_number: number | null;
	max_replicas: number;
	distributed: number;
	supply_exhausted: boolean;
	listing_price: string | null;
	listing_currency: string | null;
	created_at: string;
}

export interface IndexerNft extends IndexerNftSummary {
	description: string | null;
	image_hash: string | null;
	unique_access_key: string | null;
	original_id: string | null;
	minted_by: string | null;
	block_num: number;
	tx_id: string;
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

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
	const url = new URL(path, baseUrl);
	const response = await fetch(url.toString(), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
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
	getCollectionNfts(id: string, params?: { type?: string; limit?: number; offset?: number }): Promise<IndexerNftSummary[]>;
	getCollectionStats(id: string): Promise<CollectionStats>;

	// NFTs
	getNft(id: string): Promise<IndexerNft>;
	getNftInstances(id: string, params?: { limit?: number; offset?: number }): Promise<IndexerNftSummary[]>;

	// Users
	getUserNfts(username: string, params?: { status?: string; type?: string; limit?: number; offset?: number }): Promise<UserNftsPage>;
	getUserNftCounts(username: string): Promise<UserNftCounts>;
	getUserCollections(username: string, params?: { limit?: number; offset?: number }): Promise<IndexerCollection[]>;
	getUserPacks(username: string, params?: { limit?: number; offset?: number }): Promise<PackBalance[]>;

	// Marketplace
	getListings(params?: { sort?: string; currency?: string; limit?: number; offset?: number }): Promise<IndexerNftSummary[]>;

	// Multisig
	/** Fetch payment split info for buying an NFT */
	getPaymentInfo(nftId: string): Promise<PaymentInfo>;
	/** Request multisig signing of a buy transaction */
	multisig(request: MultisigRequest): Promise<MultisigResponse>;

	// Packs
	getPacks(params?: { collectionId?: string; limit?: number; offset?: number }): Promise<IndexerPack[]>;
	getPack(id: string): Promise<IndexerPack>;
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
			get<IndexerNftSummary[]>(baseUrl, `/api/collections/${encodeURIComponent(id)}/nfts`, params),
		getCollectionStats: (id) =>
			get<CollectionStats>(baseUrl, `/api/collections/${encodeURIComponent(id)}/stats`),

		// ---- NFTs ----
		getNft: (id) =>
			get<IndexerNft>(baseUrl, `/api/nfts/${encodeURIComponent(id)}`),
		getNftInstances: (id, params) =>
			get<IndexerNftSummary[]>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/instances`, params),

		// ---- Users ----
		getUserNfts: (username, params) =>
			get<UserNftsPage>(baseUrl, `/api/users/${encodeURIComponent(username)}/nfts`, params),
		getUserNftCounts: (username) =>
			get<UserNftCounts>(baseUrl, `/api/users/${encodeURIComponent(username)}/nfts/count`),
		getUserCollections: (username, params) =>
			get<IndexerCollection[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/collections`, params),
		getUserPacks: (username, params) =>
			get<PackBalance[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/packs`, params),

		// ---- Marketplace ----
		getListings: (params) =>
			get<IndexerNftSummary[]>(baseUrl, "/api/marketplace/listings", params),

		// ---- Multisig ----
		getPaymentInfo: (nftId) =>
			get<PaymentInfo>(baseUrl, `/api/payment-info/${encodeURIComponent(nftId)}`),
		multisig: (request) =>
			post<MultisigResponse>(baseUrl, "/api/multisig", request),

		// ---- Packs ----
		getPacks: (params) =>
			get<IndexerPack[]>(baseUrl, "/api/packs", params),
		getPack: (id) =>
			get<IndexerPack>(baseUrl, `/api/packs/${encodeURIComponent(id)}`),
	};
}

// NFTLox Indexer API Client
// Portable client using only fetch() — works in browser, Bun, and Node.

import type { PaymentInfo, MultisigRequest, MultisigResponse } from "@nftlox/protocol";
import { resolveNodeAccountFromStatus, type RequestMultisigOptions, type ResolveNodeAccountOptions } from "./multisig";
import { resolveInstance } from "./inheritance";
import { NFTLOX_POW_HEADER, solveMultisigPow } from "./pow";
import { IndexerError } from "./errors";
import { type HttpOptions, handleFetchError, headersToRecord, mergeHeaders, resolveFetch } from "./http";

// ============ ERROR (re-exported for backwards compatibility) ============

export { IndexerError };
export type { HttpOptions, FetchFunction } from "./http";

// ============ RESPONSE TYPES ============

export interface SyncStatus {
	protocolVersion: string;
	protocolId: string;
	genesisBlock?: number;
	nodeAccount: string;
	nodeUrl: string | null;
	multisigEnabled: boolean;
	multisigSignerReady?: boolean;
	multisigClockDriftOk?: boolean;
	/** Milliseconds of clock drift between the indexer host and Hive. */
	multisigClockDriftMs?: number;
	/** Protocol fee in basis points. 100 = 1%. */
	protocolFeeBps?: number;
	/** Maximum allowed royalty in basis points. 5000 = 50%. */
	maxRoyaltyBps?: number;
	supportedCurrencies?: string[];
	lastBlock: number;
	headBlock: number;
	irreversibleBlock?: number;
	blocksBehind: number;
	inSync: boolean;
}

export type IndexerNftType = "seed" | "instance";
export type IndexerNftStatus = "active" | "listed" | "burned" | "lent";
export type IndexerOwnershipAction = "mint" | "bulk_distribute" | "transfer" | "nft_transfer_from" | "buy";
export type UserNftFilterStatus = "active" | "listed" | "lent";
export type LoanRole = "lender" | "borrower" | "all";
export type ListingSort = "price_asc" | "price_desc" | "recent";

export type HealthMode = "liveness" | "readiness";

export type HealthSyncState =
	| "starting"
	| "catching-up"
	| "ready"
	| "stale"
	| "unreachable";

export interface HealthCheck {
	mode: HealthMode;
	status: "healthy" | "unhealthy";
	db: "ok" | "unreachable";
	hive: "ok" | "unreachable";
	sync: HealthSyncState;
	syncActive: boolean;
	inSync: boolean;
	lastBlock: number;
	headBlock: number;
	irreversibleBlock: number;
	blocksBehind: number;
	secondsSinceUpdate: number | null;
}

export interface HealthStatus {
	status: "healthy" | "unhealthy";
	liveness: HealthCheck;
	readiness: HealthCheck;
}

export interface ProtocolStats {
	total_collections: number;
	total_nfts: number;
	total_seeds: number;
	total_instances: number;
	total_listed: number;
	total_burned: number;
	unique_owners: number;
	invalid_ops: number;
	total_schema_versions: number;
	sales: MarketplaceVolume[];
}

export interface UserNftCounts {
	total: number;
	seeds: number;
	instances: number;
}

export interface UserNftsPage {
	nfts: IndexerNftSummary[];
	counts: UserNftCounts;
	offset: number;
	limit: number;
}

export interface UserLoansPage {
	username: string;
	role: LoanRole;
	loans: IndexerNftLoan[];
	total: number;
	offset: number;
	limit: number;
}

export interface UserAssetsOverview {
	username: string;
	counts: {
		owned: number;
		seeds: number;
		collections: number;
		lentOut: number;
		borrowed: number;
	};
	assets: {
		owned: IndexerNftSummary[];
		seeds: IndexerNftSummary[];
		lentOut: IndexerNftLoan[];
		borrowed: IndexerNftLoan[];
		collections: IndexerCollectionSummary[];
	};
	previewLimit: number;
}

export interface IndexerCollectionBase {
	id: string;
	name: string;
	symbol: string;
	creator: string;
	total_potential: number;
	description: string | null;
	image_url: string | null;
	external_url: string | null;
	transferable: boolean;
	burnable: boolean;
	/** Whole percent value in protocol 0.5.x, serialized from PostgreSQL numeric. */
	royalty_pct: string;
	royalty_recipient: string | null;
	status: "active" | "archived";
	schema_version: number;
	tx_id: string;
	created_at: string;
}

export interface IndexerCollectionSummary extends IndexerCollectionBase {
	seed_count: number;
	instance_count: number;
}

export interface IndexerCollection extends IndexerCollectionBase {
	schema: unknown | null;
}

export interface CollectionStats {
	total_seeds: number;
	total_instances: number;
	total_listed: number;
	total_burned: number;
	unique_owners: number;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	floor_price: string | null;
}

export interface SchemaHistoryEntry {
	version: number;
	schema: unknown;
	schema_hash: string;
	prev_hash: string | null;
	block_num: number;
	tx_id: string;
	created_at: string;
}

export interface IndexerNftSummary {
	id: string;
	collection_id: string;
	nft_type: IndexerNftType;
	status: IndexerNftStatus;
	edition: number;
	owner: string;
	name: string;
	image_url: string | null;
	origin_dna: string | null;
	immutable_data: Record<string, unknown> | null;
	instance_dna: string | null;
	seed_id: string | null;
	seed_tx_id: string | null;
	instance_number: number | null;
	max_supply: number;
	distributed: number;
	supply_exhausted: boolean;
	schema_version: number | null;
	previous_owner: string | null;
	owner_operation_id: string;
	owner_action: IndexerOwnershipAction;
	owner_block_num: number;
	listing_id: string | null;
	listing_tx_id: string | null;
	listing_price: string | null;
	listing_currency: string | null;
	listing_expires_at: string | null;
	created_at: string;
}

export interface IndexerNft extends IndexerNftSummary {
	data_hash: string | null;
	tx_id: string;
	minted_by: string | null;
	listing_marketplace: string | null;
	listing_expired: boolean;
}

export interface IndexerNftOwner {
	id: string;
	owner: string;
	previous_owner: string | null;
	owner_action: IndexerOwnershipAction;
	owner_operation_id: string;
	owner_block_num: number;
	claim_hash: string;
}

export interface IndexerNftProof extends IndexerNftOwner {
	created_operation_id: string;
	created_block_num: number;
	created_tx_id: string;
	nft_type: IndexerNftType;
	seed_id: string | null;
	instance_number: number | null;
	instance_dna: string | null;
}

export interface IndexerNftLoan {
	nft_id: string;
	collection_id: string;
	nft_type: IndexerNftType;
	status: IndexerNftStatus;
	owner: string;
	name: string;
	image_url: string | null;
	seed_id: string | null;
	seed_tx_id: string | null;
	instance_number: number | null;
	owner_operation_id: string;
	owner_action: IndexerOwnershipAction;
	owner_block_num: number;
	lender: string;
	borrower: string;
	loan_operation_id: string;
	loan_block_num: number;
	loan_tx_id: string;
	loan_created_at: string;
}

export interface IndexerNftLoanStatus {
	nft_id: string;
	active: boolean;
	loan: IndexerNftLoan | null;
}

export interface MarketplaceSale {
	nft_id: string;
	collection_id: string;
	listing_id: string;
	seller: string;
	buyer: string;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	gross_amount: string;
	currency: string;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	royalty_amount: string;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	protocol_fee: string;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	seller_net: string;
	tx_id: string;
	created_at: string;
}

export interface MarketplaceVolume {
	currency: string;
	total_sales: number;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	volume: string;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	total_royalties: string;
	/** Decimal Hive asset value serialized from PostgreSQL numeric. */
	total_fees: string;
}

export type OperationState = "confirmed" | "invalid" | "orphaned";

export interface OperationStatusEntry {
	readonly status: OperationState;
	readonly operationId: string | null;
	readonly signer: string | null;
	readonly action: string | null;
	readonly reason: string | null;
	readonly blockNum: number | null;
	readonly timestamp: string | null;
	readonly nftIds: ReadonlyArray<string>;
}

export interface OperationStatusResult {
	readonly txId: string;
	// False when the indexer has no record of this txId yet (not broadcast,
	// still propagating, or never seen). Poll again to disambiguate.
	readonly indexed: boolean;
	readonly totalOperations: number;
	readonly confirmed: number;
	readonly invalid: number;
	readonly orphaned: number;
	readonly operations: ReadonlyArray<OperationStatusEntry>;
}

export type CollectionsQueryParams = QueryParams & Readonly<{
	creator?: string;
	limit?: number;
	offset?: number;
}>;

export type CollectionNftsQueryParams = QueryParams & Readonly<{
	type?: IndexerNftType;
	limit?: number;
	offset?: number;
}>;

export type UserNftsQueryParams = QueryParams & Readonly<{
	status?: UserNftFilterStatus;
	type?: IndexerNftType;
	limit?: number;
	offset?: number;
}>;

export type UserLoansQueryParams = QueryParams & Readonly<{
	role?: LoanRole;
	limit?: number;
	offset?: number;
}>;

export type UserAssetsQueryParams = QueryParams & Readonly<{
	previewLimit?: number;
}>;

export type ListingsQueryParams = QueryParams & Readonly<{
	sort?: ListingSort;
	currency?: string;
	limit?: number;
	offset?: number;
}>;

export type SalesQueryParams = QueryParams & Readonly<{
	nftId?: string;
	collectionId?: string;
	seller?: string;
	buyer?: string;
	limit?: number;
	offset?: number;
}>;

export type SalesVolumeQueryParams = QueryParams & Readonly<{
	collectionId?: string;
}>;

export type OperationStatusQueryParams = QueryParams & Readonly<{
	operationId?: string;
	action?: string;
}>;

/** Internal: compact response from the instances endpoint (?compact=true). */
interface CompactInstancesResponse {
	seed: IndexerNftSummary;
	instances: IndexerNftSummary[];
}

// ============ INTERNAL HELPERS ============

type QueryParams = { [key: string]: string | number | boolean | undefined | null };

async function get<T>(
	baseUrl: string,
	path: string,
	params?: QueryParams,
	http?: HttpOptions,
): Promise<T> {
	const url = new URL(path, baseUrl);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}
	}
	const urlString = url.toString();
	const fetchImpl = resolveFetch(http);
	let response: Response;
	try {
		response = await fetchImpl(urlString, {
			headers: http?.headers,
			signal: http?.signal,
		});
	} catch (error) {
		throw handleFetchError({ error, url: urlString });
	}
	if (!response.ok) {
		throw new IndexerError({
			message: `Indexer error ${response.status}: ${response.statusText}`,
			url: urlString,
			statusCode: response.status,
			responseHeaders: headersToRecord(response.headers),
			responseBody: await response.text(),
		});
	}
	const data = await response.json();
	if (data === null || data === undefined) {
		throw new IndexerError({
			message: "Invalid response: null or undefined body",
			url: urlString,
			statusCode: 502,
		});
	}
	return data as T;
}

async function post<T>(
	baseUrl: string,
	path: string,
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
	http?: HttpOptions,
): Promise<T> {
	const urlString = new URL(path, baseUrl).toString();
	const fetchImpl = resolveFetch(http);
	const mergedHeaders = mergeHeaders(
		{ "Content-Type": "application/json", ...headers },
		http?.headers,
	);
	let response: Response;
	try {
		response = await fetchImpl(urlString, {
			method: "POST",
			headers: mergedHeaders,
			body: JSON.stringify(body),
			signal: http?.signal,
		});
	} catch (error) {
		throw handleFetchError({ error, url: urlString, requestBodyValues: body });
	}
	if (!response.ok) {
		throw new IndexerError({
			message: `Indexer error ${response.status}: ${response.statusText}`,
			url: urlString,
			requestBodyValues: body,
			statusCode: response.status,
			responseHeaders: headersToRecord(response.headers),
			responseBody: await response.text(),
		});
	}
	const data = await response.json();
	if (data === null || data === undefined) {
		throw new IndexerError({
			message: "Invalid response: null or undefined body",
			url: urlString,
			requestBodyValues: body,
			statusCode: 502,
		});
	}
	return data as T;
}

// ============ CLIENT FACTORY ============

export interface IndexerClient {
	// Status
	getStatus(): Promise<SyncStatus>;
	getNodeAccount(options?: ResolveNodeAccountOptions): Promise<string>;
	getMultisigNodeAccount(): Promise<string>;
	getHealth(): Promise<HealthStatus>;
	getStats(): Promise<ProtocolStats>;

	// Collections
	getCollections(params?: CollectionsQueryParams): Promise<IndexerCollectionSummary[]>;
	getCollection(id: string): Promise<IndexerCollection>;
	getCollectionSchemaHistory(id: string): Promise<ReadonlyArray<SchemaHistoryEntry>>;
	getCollectionNfts(id: string, params?: CollectionNftsQueryParams): Promise<IndexerNftSummary[]>;
	getCollectionStats(id: string): Promise<CollectionStats>;

	// NFTs
	getNft(id: string): Promise<IndexerNft>;
	getNftOwner(id: string): Promise<IndexerNftOwner>;
	getNftOwnership(id: string): Promise<IndexerNftProof>;
	getNftProof(id: string): Promise<IndexerNftProof>;
	getNftLoan(id: string): Promise<IndexerNftLoanStatus>;
	getNftInstances(id: string, params?: { limit?: number; offset?: number; compact?: boolean }): Promise<IndexerNftSummary[]>;

	// Users
	getUserAssets(username: string, params?: UserAssetsQueryParams): Promise<UserAssetsOverview>;
	getUserNfts(username: string, params?: UserNftsQueryParams): Promise<UserNftsPage>;
	getUserNftCounts(username: string): Promise<UserNftCounts>;
	getUserCollections(username: string, params?: Omit<CollectionsQueryParams, "creator">): Promise<IndexerCollectionSummary[]>;
	getUserLoans(username: string, params?: UserLoansQueryParams): Promise<UserLoansPage>;

	// Marketplace
	getListings(params?: ListingsQueryParams): Promise<IndexerNftSummary[]>;
	getSales(params?: SalesQueryParams): Promise<ReadonlyArray<MarketplaceSale>>;
	getSalesVolume(params?: SalesVolumeQueryParams): Promise<ReadonlyArray<MarketplaceVolume>>;
	/** @deprecated Use getSalesVolume(params) instead. */
	getVolume(params?: SalesVolumeQueryParams): Promise<ReadonlyArray<MarketplaceVolume>>;

	// Operations
	getOperationStatus(txId: string, params?: OperationStatusQueryParams): Promise<OperationStatusResult>;

	// Multisig
	/** Fetch payment split info for buying an NFT */
	getPaymentInfo(nftId: string): Promise<PaymentInfo>;
	/** Request multisig signing of a buy transaction */
	multisig(request: MultisigRequest, options?: RequestMultisigOptions): Promise<MultisigResponse>;
}

/**
 * Creates an indexer API client.
 *
 * SECURITY: When used server-side (Node.js/Bun), ensure baseUrl points to a trusted
 * indexer to prevent SSRF. Do not pass user-controlled URLs.
 */
export function createIndexerClient(baseUrl: string, options?: HttpOptions): IndexerClient {
	const http = options;
	const getStatus = () => get<SyncStatus>(baseUrl, "/api/status", undefined, http);

	return {
		// ---- Status ----
		getStatus,
		getNodeAccount: async (resolveOptions) => resolveNodeAccountFromStatus(await getStatus(), resolveOptions),
		getMultisigNodeAccount: async () => resolveNodeAccountFromStatus(
			await getStatus(),
			{ requireMultisigReady: true },
		),
		getHealth: () => get<HealthStatus>(baseUrl, "/api/health", undefined, http),
		getStats: () => get<ProtocolStats>(baseUrl, "/api/stats", undefined, http),

		// ---- Collections ----
		getCollections: (params) =>
			get<IndexerCollectionSummary[]>(baseUrl, "/api/collections", params, http),
		getCollection: (id) =>
			get<IndexerCollection>(baseUrl, `/api/collections/${encodeURIComponent(id)}`, undefined, http),
		getCollectionSchemaHistory: (id) =>
			get<SchemaHistoryEntry[]>(baseUrl, `/api/collections/${encodeURIComponent(id)}/schema-history`, undefined, http),
		getCollectionNfts: (id, params) =>
			get<IndexerNftSummary[]>(baseUrl, `/api/collections/${encodeURIComponent(id)}/nfts`, params, http),
		getCollectionStats: (id) =>
			get<CollectionStats>(baseUrl, `/api/collections/${encodeURIComponent(id)}/stats`, undefined, http),

		// ---- NFTs ----
		getNft: (id) =>
			get<IndexerNft>(baseUrl, `/api/nfts/${encodeURIComponent(id)}`, undefined, http),
		getNftOwner: (id) =>
			get<IndexerNftOwner>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/owner`, undefined, http),
		getNftOwnership: (id) =>
			get<IndexerNftProof>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/ownership`, undefined, http),
		getNftProof: (id) =>
			get<IndexerNftProof>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/proof`, undefined, http),
		getNftLoan: (id) =>
			get<IndexerNftLoanStatus>(baseUrl, `/api/nfts/${encodeURIComponent(id)}/loan`, undefined, http),
		getNftInstances: async (id, params) => {
			const path = `/api/nfts/${encodeURIComponent(id)}/instances`;
			if (params?.compact) {
				const { seed, instances } = await get<CompactInstancesResponse>(baseUrl, path, { ...params, compact: true }, http);
				return instances.map((inst) => resolveInstance(inst, seed));
			}
			return get<IndexerNftSummary[]>(baseUrl, path, params, http);
		},

		// ---- Users ----
		getUserAssets: (username, params) =>
			get<UserAssetsOverview>(baseUrl, `/api/users/${encodeURIComponent(username)}/assets`, params, http),
		getUserNfts: (username, params) =>
			get<UserNftsPage>(baseUrl, `/api/users/${encodeURIComponent(username)}/nfts`, params, http),
		getUserNftCounts: (username) =>
			get<UserNftCounts>(baseUrl, `/api/users/${encodeURIComponent(username)}/nfts/count`, undefined, http),
		getUserCollections: (username, params) =>
			get<IndexerCollectionSummary[]>(baseUrl, `/api/users/${encodeURIComponent(username)}/collections`, params, http),
		getUserLoans: (username, params) =>
			get<UserLoansPage>(baseUrl, `/api/users/${encodeURIComponent(username)}/loans`, params, http),

		// ---- Marketplace ----
		getListings: (params) =>
			get<IndexerNftSummary[]>(baseUrl, "/api/marketplace/listings", params, http),
		getSales: (params) =>
			get<MarketplaceSale[]>(baseUrl, "/api/marketplace/sales", params, http),
		getSalesVolume: (params) =>
			get<MarketplaceVolume[]>(baseUrl, "/api/marketplace/volume", params, http),
		getVolume: (params) =>
			get<MarketplaceVolume[]>(baseUrl, "/api/marketplace/volume", params, http),

		// ---- Operations ----
		getOperationStatus: (txId, params) =>
			get<OperationStatusResult>(baseUrl, `/api/operation-status/${encodeURIComponent(txId)}`, params, http),

		// ---- Multisig ----
		getPaymentInfo: (nftId) =>
			get<PaymentInfo>(baseUrl, `/api/payment-info/${encodeURIComponent(nftId)}`, undefined, http),
		multisig: async (request, multisigOptions) => {
			const powToken = await solveMultisigPow(request, multisigOptions?.powBits);
			return post<MultisigResponse>(
				baseUrl,
				"/api/multisig",
				request,
				{ [NFTLOX_POW_HEADER]: powToken },
				http,
			);
		},
	};
}

import { sql, type Queryable, clampLimit } from "@/db/client.ts";

export type NftKind = "seed" | "instance" | "replica";
export type NftStatus = "active" | "listed" | "burned" | "lent";

export const VALID_NFT_KINDS = new Set<NftKind>(["seed", "instance", "replica"]);
export const VALID_NFT_STATUSES = new Set<NftStatus>(["active", "listed", "burned", "lent"]);

export const parseNftKind = (value: string | undefined): NftKind | undefined =>
	value !== undefined && VALID_NFT_KINDS.has(value as NftKind) ? value as NftKind : undefined;

export const parseNftStatus = (value: string | undefined): NftStatus | undefined =>
	value !== undefined && VALID_NFT_STATUSES.has(value as NftStatus) ? value as NftStatus : undefined;

export const NFT_STATUS_ACTIVE: NftStatus = "active";
export const NFT_STATUS_LISTED: NftStatus = "listed";
export const NFT_STATUS_BURNED: NftStatus = "burned";
export const NFT_STATUS_LENT: NftStatus = "lent";

export interface InsertNftParams {
	id: string;
	collectionId: string;
	nftType: NftKind;
	status?: NftStatus;
	edition: number;
	owner: string;
	originDna: string | null;
	instanceDna: string | null;
	uniqueAccessKey: string | null;
	birthBlock: number;
	birthTx: string;
	mintedBy: string;
	name: string;
	description: string | null;
	imageUrl: string | null;
	imageHash: string | null;
	maxReplicas: number;
	distributed?: number;
	seedId: string | null;
	instanceNumber: number | null;
	originalId: string | null;
	immutableData: unknown | null;
	immutableDataHash: string | null;
	mutableData: unknown | null;
	mutableDataHash: string | null;
	blockNum: number;
	txId: string;
	createdAt: string;
}

export async function insertNft(params: InsertNftParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO nfts (
			id, collection_id, nft_type, status, edition, owner,
			origin_dna, instance_dna, unique_access_key,
			birth_block, birth_tx, minted_by,
			name, description, image_url, image_hash,
			max_replicas, distributed,
			seed_id, instance_number, original_id,
			immutable_data, immutable_data_hash,
			mutable_data, mutable_data_hash, mutable_data_tx, mutable_data_block,
			block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.collectionId}, ${params.nftType},
			${params.status ?? NFT_STATUS_ACTIVE}, ${params.edition}, ${params.owner},
			${params.originDna}, ${params.instanceDna}, ${params.uniqueAccessKey},
			${params.birthBlock}, ${params.birthTx}, ${params.mintedBy},
			${params.name}, ${params.description}, ${params.imageUrl}, ${params.imageHash},
			${params.maxReplicas}, ${params.distributed ?? 0},
			${params.seedId}, ${params.instanceNumber}, ${params.originalId},
			${params.immutableData ? JSON.stringify(params.immutableData) : null},
			${params.immutableDataHash},
			${params.mutableData ? JSON.stringify(params.mutableData) : null},
			${params.mutableDataHash},
			${params.mutableData ? params.txId : null},
			${params.mutableData ? params.blockNum : null},
			${params.blockNum}, ${params.txId}, ${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	return result.count > 0;
}

export async function getNftById(id: string) {
	const [row] = await sql`
		SELECT n.*,
			COALESCE(NULLIF(n.name, ''), s.name) AS name,
			COALESCE(n.image_url, s.image_url) AS image_url,
			COALESCE(n.image_hash, s.image_hash) AS image_hash,
			COALESCE(n.origin_dna, s.origin_dna) AS origin_dna,
			COALESCE(n.immutable_data, s.immutable_data) AS immutable_data,
			COALESCE(n.immutable_data_hash, s.immutable_data_hash) AS immutable_data_hash
		FROM nfts n
		LEFT JOIN nfts s ON s.id = n.seed_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export async function nftExists(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM nfts WHERE id = ${id}`;
	return !!row;
}

export interface NftProcessingRow {
	id: string;
	owner: string;
	status: NftStatus;
	nft_type: NftKind;
	name: string;
	seed_id: string | null;
	max_replicas: number;
	distributed: number;
	collection_id: string;
	instance_dna: string | null;
	listing_id: string | null;
	listing_tx_id: string | null;
	listing_price: string | null;
	listing_currency: string | null;
	listing_expires_at: string | null;
	listing_marketplace: string | null;
	mutable_data: unknown | null;
}

export async function getNftForProcessing(id: string, txn: Queryable = sql): Promise<NftProcessingRow | null> {
	const [row] = await txn<NftProcessingRow[]>`
		SELECT id, owner, status, nft_type, name, seed_id, max_replicas, distributed, collection_id, instance_dna,
		       listing_id, listing_tx_id, listing_price, listing_currency, listing_expires_at, listing_marketplace, mutable_data
		FROM nfts WHERE id = ${id}
	`;
	return row ?? null;
}

export interface NftWithRulesRow extends NftProcessingRow {
	creator: string;
	transferable: boolean;
	burnable: boolean;
	replicable: boolean;
	royalty_pct: number;
	royalty_recipient: string | null;
}

export async function getNftWithCollectionRules(
	id: string,
	txn: Queryable = sql,
): Promise<NftWithRulesRow | null> {
	const [row] = await txn<NftWithRulesRow[]>`
		SELECT
			n.id, n.owner, n.status, n.nft_type, n.name, n.seed_id, n.max_replicas, n.distributed,
			n.collection_id, n.instance_dna, n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency,
			n.listing_expires_at, n.listing_marketplace,
			c.creator, c.transferable, c.burnable, c.replicable, c.royalty_pct, c.royalty_recipient
		FROM nfts n
		JOIN collections c ON c.id = n.collection_id
		WHERE n.id = ${id}
	`;
	return row ?? null;
}

export interface SeedWithDnaRow {
	id: string;
	owner: string;
	status: NftStatus;
	nft_type: NftKind;
	name: string;
	seed_id: string | null;
	max_replicas: number;
	distributed: number;
	collection_id: string;
	instance_dna: string | null;
	origin_dna: string | null;
	image_url: string | null;
	image_hash: string | null;
	immutable_data: unknown | null;
}

export async function getSeedWithDna(id: string, txn: Queryable = sql): Promise<SeedWithDnaRow | null> {
	const [row] = await txn<SeedWithDnaRow[]>`
		SELECT id, owner, status, nft_type, name, seed_id, max_replicas, distributed,
			collection_id, instance_dna, origin_dna, image_url, image_hash, immutable_data
		FROM nfts WHERE id = ${id}
	`;
	return row ?? null;
}

export async function updateNftOwner(nftId: string, newOwner: string, txn: Queryable = sql) {
	await txn`
		UPDATE nfts
		SET owner = ${newOwner}, status = ${NFT_STATUS_ACTIVE},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL
		WHERE id = ${nftId}
	`;
}

export async function updateNftStatus(nftId: string, status: NftStatus, txn: Queryable = sql) {
	await txn`UPDATE nfts SET status = ${status} WHERE id = ${nftId}`;
}

export async function updateNftBurned(nftId: string, burnedBy: string, blockNum: number, txn: Queryable = sql) {
	await txn`
		UPDATE nfts
		SET status = ${NFT_STATUS_BURNED},
		    burned_by = ${burnedBy}, burned_at_block = ${blockNum},
		    listing_id = NULL, listing_tx_id = NULL,
		    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL
		WHERE id = ${nftId}
	`;
}

export async function updateNftListing(
	nftId: string,
	price: number | null,
	currency: string | null,
	expiresAt: number | null,
	marketplace: string | null,
	listingId: string | null,
	listingTxId: string | null,
	txn: Queryable = sql,
) {
	if (price === null) {
		await txn`
			UPDATE nfts
			SET status = ${NFT_STATUS_ACTIVE},
			    listing_id = NULL, listing_tx_id = NULL,
			    listing_price = NULL, listing_currency = NULL, listing_expires_at = NULL, listing_marketplace = NULL
			WHERE id = ${nftId}
		`;
	} else {
		const expiresIso = expiresAt ? new Date(expiresAt).toISOString() : null;
		await txn`
			UPDATE nfts
			SET status = ${NFT_STATUS_LISTED},
			    listing_id = ${listingId}, listing_tx_id = ${listingTxId},
			    listing_price = ${price}, listing_currency = ${currency},
			    listing_expires_at = ${expiresIso}, listing_marketplace = ${marketplace}
			WHERE id = ${nftId}
		`;
	}
}

export async function incrementDistributed(seedId: string, txn: Queryable = sql) {
	await txn`UPDATE nfts SET distributed = distributed + 1 WHERE id = ${seedId}`;
}

export async function incrementDistributedBy(seedId: string, quantity: number, txn: Queryable = sql) {
	await txn`UPDATE nfts SET distributed = distributed + ${quantity} WHERE id = ${seedId}`;
}



export async function updateNftMutableData(
	nftId: string,
	mergedData: Record<string, unknown>,
	dataHash: string,
	txId: string,
	blockNum: number,
	txn: Queryable = sql,
) {
	// Write the FULL merged object (not partial merge) to guarantee hash matches stored value
	await txn`
		UPDATE nfts
		SET mutable_data = ${JSON.stringify(mergedData)}::jsonb,
			mutable_data_hash = ${dataHash},
			mutable_data_tx = ${txId},
			mutable_data_block = ${blockNum}
		WHERE id = ${nftId}
	`;
}

export async function updateNftOwnerData(
	nftId: string,
	ownerData: Record<string, unknown>,
	dataHash: string,
	txId: string,
	blockNum: number,
	txn: Queryable = sql,
) {
	await txn`
		UPDATE nfts
		SET owner_data = ${JSON.stringify(ownerData)},
			owner_data_hash = ${dataHash},
			owner_data_tx = ${txId},
			owner_data_block = ${blockNum}
		WHERE id = ${nftId}
	`;
}

export interface UserNftCounts {
	total: number;
	seeds: number;
	instances: number;
	replicas: number;
}

export async function getUserNftCounts(owner: string, txn: Queryable = sql): Promise<UserNftCounts> {
	const [row] = await txn`
		SELECT total, seeds, instances, replicas
		FROM owner_nft_counts
		WHERE owner = ${owner}
	`;
	return {
		total: row?.total ?? 0,
		seeds: row?.seeds ?? 0,
		instances: row?.instances ?? 0,
		replicas: row?.replicas ?? 0,
	};
}

export async function repairOwnerNftCounts(txn: Queryable = sql): Promise<number> {
	const result = await txn`
		WITH expected AS (
			SELECT owner,
				COUNT(*)::int AS total,
				COUNT(*) FILTER (WHERE nft_type = 'seed')::int AS seeds,
				COUNT(*) FILTER (WHERE nft_type = 'instance')::int AS instances,
				COUNT(*) FILTER (WHERE nft_type = 'replica')::int AS replicas
			FROM nfts WHERE status != 'burned'
			GROUP BY owner
		)
		INSERT INTO owner_nft_counts (owner, total, seeds, instances, replicas)
		SELECT * FROM expected
		ON CONFLICT (owner) DO UPDATE SET
			total = EXCLUDED.total, seeds = EXCLUDED.seeds,
			instances = EXCLUDED.instances, replicas = EXCLUDED.replicas
		WHERE owner_nft_counts.total != EXCLUDED.total
			OR owner_nft_counts.seeds != EXCLUDED.seeds
			OR owner_nft_counts.instances != EXCLUDED.instances
			OR owner_nft_counts.replicas != EXCLUDED.replicas
	`;
	return result.count;
}

export type ListSort = "price_asc" | "price_desc" | "recent";

export type NftListQuery =
	| { by: "owner"; owner: string; status?: NftStatus; type?: NftKind }
	| { by: "collection"; collectionId: string; type?: NftKind }
	| { by: "seed"; seedId: string }
	| { by: "listed"; sort?: ListSort; currency?: string };

export type Pagination = { limit?: number; offset?: number };

const LIST_COLUMNS = sql`
	n.id, n.collection_id, n.nft_type, n.status, n.edition, n.owner,
	COALESCE(NULLIF(n.name, ''), s.name) AS name,
	COALESCE(n.image_url, s.image_url) AS image_url,
	COALESCE(n.origin_dna, s.origin_dna) AS origin_dna,
	n.instance_dna,
	n.seed_id, n.instance_number,
	n.max_replicas, n.distributed, n.supply_exhausted,
	n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency, n.listing_expires_at, n.created_at
`;

export interface NftListRow {
	id: string;
	collection_id: string;
	nft_type: NftKind;
	status: NftStatus;
	edition: number;
	owner: string;
	name: string;
	image_url: string | null;
	origin_dna: string | null;
	instance_dna: string | null;
	seed_id: string | null;
	instance_number: number | null;
	max_replicas: number;
	distributed: number;
	supply_exhausted: boolean;
	listing_id: string | null;
	listing_tx_id: string | null;
	listing_price: string | null;
	listing_currency: string | null;
	listing_expires_at: string | null;
	created_at: string;
}

export interface NftPageResult {
	nfts: ReadonlyArray<NftListRow>;
	counts: UserNftCounts;
}

export async function queryNftsWithCounts(
	owner: string,
	status?: NftStatus,
	type?: NftKind,
	page?: Pagination,
): Promise<NftPageResult> {
	const safeLimit = clampLimit(page?.limit ?? 50);
	const offset = page?.offset ?? 0;
	const statusFilter = status ? sql`AND n.status = ${status}` : sql``;
	const typeFilter = type ? sql`AND n.nft_type = ${type}` : sql``;

	const [nfts, counts] = await Promise.all([
		sql<NftListRow[]>`
			SELECT ${LIST_COLUMNS} FROM nfts n LEFT JOIN nfts s ON s.id = n.seed_id
			WHERE n.owner = ${owner} ${statusFilter} ${typeFilter}
			ORDER BY n.created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
		`,
		getUserNftCounts(owner),
	]);

	return { nfts, counts };
}

export async function queryNfts(query: NftListQuery, page?: Pagination) {
	const safeLimit = clampLimit(page?.limit ?? 50);
	const offset = page?.offset ?? 0;

	switch (query.by) {
		case "owner": {
			const statusFilter = query.status ? sql`AND n.status = ${query.status}` : sql``;
			const typeFilter = query.type ? sql`AND n.nft_type = ${query.type}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.owner = ${query.owner} ${statusFilter} ${typeFilter}
				ORDER BY n.created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "collection": {
			const typeFilter = query.type ? sql`AND n.nft_type = ${query.type}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.collection_id = ${query.collectionId} ${typeFilter}
				ORDER BY n.created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "seed": {
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.seed_id = ${query.seedId}
				ORDER BY n.instance_number ASC
				LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "listed": {
			const orderClause = query.sort === "price_asc"
				? sql`n.listing_price ASC`
				: query.sort === "price_desc"
					? sql`n.listing_price DESC`
					: sql`n.created_at DESC`;
			const currencyFilter = query.currency ? sql`AND n.listing_currency = ${query.currency}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.status = ${NFT_STATUS_LISTED} ${currencyFilter} AND (n.listing_expires_at IS NULL OR n.listing_expires_at > NOW())
				ORDER BY ${orderClause}
				LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
	}
}

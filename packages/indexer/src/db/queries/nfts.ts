import { sql, type Queryable, clampLimit } from "@/db/client.ts";

export type NftKind = "seed" | "instance" | "replica";
export type NftStatus = "active" | "listed" | "burned" | "lent";

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
	tags: string[] | null;
	customData: unknown | null;
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
			tags, custom_data,
			block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.collectionId}, ${params.nftType},
			${params.status ?? NFT_STATUS_ACTIVE}, ${params.edition}, ${params.owner},
			${params.originDna}, ${params.instanceDna}, ${params.uniqueAccessKey},
			${params.birthBlock}, ${params.birthTx}, ${params.mintedBy},
			${params.name}, ${params.description}, ${params.imageUrl}, ${params.imageHash},
			${params.maxReplicas}, ${params.distributed ?? 0},
			${params.seedId}, ${params.instanceNumber}, ${params.originalId},
			${params.tags}, ${params.customData ? JSON.stringify(params.customData) : null},
			${params.blockNum}, ${params.txId}, ${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	return result.count > 0;
}

export async function getNftById(id: string) {
	const [row] = await sql`SELECT * FROM nfts WHERE id = ${id}`;
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
}

export async function getNftForProcessing(id: string, txn: Queryable = sql): Promise<NftProcessingRow | null> {
	const [row] = await txn<NftProcessingRow[]>`
		SELECT id, owner, status, nft_type, name, seed_id, max_replicas, distributed, collection_id, instance_dna
		FROM nfts WHERE id = ${id}
	`;
	return row ?? null;
}

export interface SeedWithDnaRow extends NftProcessingRow {
	origin_dna: string | null;
	image_url: string | null;
	image_hash: string | null;
}

export async function getSeedWithDna(id: string, txn: Queryable = sql): Promise<SeedWithDnaRow | null> {
	const [row] = await txn<SeedWithDnaRow[]>`
		SELECT id, owner, status, nft_type, name, seed_id, max_replicas, distributed,
			collection_id, instance_dna, origin_dna, image_url, image_hash
		FROM nfts WHERE id = ${id}
	`;
	return row ?? null;
}

export async function updateNftOwner(nftId: string, newOwner: string, txn: Queryable = sql) {
	await txn`
		UPDATE nfts
		SET owner = ${newOwner}, status = ${NFT_STATUS_ACTIVE}, listing_price = NULL, listing_currency = NULL
		WHERE id = ${nftId}
	`;
}

export async function updateNftStatus(nftId: string, status: NftStatus, txn: Queryable = sql) {
	await txn`UPDATE nfts SET status = ${status} WHERE id = ${nftId}`;
}

export async function updateNftBurned(nftId: string, txn: Queryable = sql) {
	await txn`
		UPDATE nfts
		SET status = ${NFT_STATUS_BURNED}, listing_price = NULL, listing_currency = NULL
		WHERE id = ${nftId}
	`;
}

export async function updateNftListing(
	nftId: string,
	price: number | null,
	currency: string | null,
	txn: Queryable = sql,
) {
	if (price === null) {
		await txn`
			UPDATE nfts
			SET status = ${NFT_STATUS_ACTIVE}, listing_price = NULL, listing_currency = NULL
			WHERE id = ${nftId}
		`;
	} else {
		await txn`
			UPDATE nfts
			SET status = ${NFT_STATUS_LISTED}, listing_price = ${price}, listing_currency = ${currency}
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



export async function updateNftCustomData(
	nftId: string,
	data: unknown | null,
	tags: string[] | null,
	txn: Queryable = sql,
) {
	await txn`
		UPDATE nfts
		SET custom_data = ${data ? JSON.stringify(data) : null},
			tags = ${tags}
		WHERE id = ${nftId}
	`;
}

export async function updateNftOperatorData(
	nftId: string,
	data: unknown | null,
	tags: string[] | null,
	txn: Queryable = sql,
) {
	await txn`
		UPDATE nfts
		SET operator_data = ${data ? JSON.stringify(data) : null},
			tags = ${tags}
		WHERE id = ${nftId}
	`;
}

export type ListSort = "price_asc" | "price_desc" | "recent";

export type NftListQuery =
	| { by: "owner"; owner: string; status?: NftStatus; type?: NftKind }
	| { by: "collection"; collectionId: string; type?: NftKind }
	| { by: "seed"; seedId: string }
	| { by: "listed"; sort?: ListSort; currency?: string };

export type Pagination = { limit?: number; offset?: number };

const LIST_COLUMNS = sql`
	id, collection_id, nft_type, status, edition, owner,
	name, image_url, origin_dna, instance_dna,
	seed_id, instance_number,
	max_replicas, distributed, supply_exhausted,
	listing_price, listing_currency, created_at
`;

export async function queryNfts(query: NftListQuery, page?: Pagination) {
	const safeLimit = clampLimit(page?.limit ?? 50);
	const offset = page?.offset ?? 0;

	switch (query.by) {
		case "owner": {
			const statusFilter = query.status ? sql`AND status = ${query.status}` : sql``;
			const typeFilter = query.type ? sql`AND nft_type = ${query.type}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts
				WHERE owner = ${query.owner} ${statusFilter} ${typeFilter}
				ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "collection": {
			const typeFilter = query.type ? sql`AND nft_type = ${query.type}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts
				WHERE collection_id = ${query.collectionId} ${typeFilter}
				ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "seed": {
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts
				WHERE seed_id = ${query.seedId}
				ORDER BY instance_number ASC
				LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "listed": {
			const orderClause = query.sort === "price_asc"
				? sql`listing_price ASC`
				: query.sort === "price_desc"
					? sql`listing_price DESC`
					: sql`created_at DESC`;
			const currencyFilter = query.currency ? sql`AND listing_currency = ${query.currency}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts
				WHERE status = ${NFT_STATUS_LISTED} ${currencyFilter}
				ORDER BY ${orderClause}
				LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
	}
}

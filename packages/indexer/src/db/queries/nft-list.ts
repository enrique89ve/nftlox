import { sql, type Queryable, clampLimit } from "@/db/client.ts";
import type { NftKind, NftStatus, NftListRow, NftListQuery, UserNftCounts, NftPageResult, Pagination } from "./nft-types.ts";
import { NFT_STATUS_LISTED } from "./nft-types.ts";

const LIST_COLUMNS = sql`
	n.id, n.collection_id, n.nft_type, n.status, n.edition, n.owner,
	COALESCE(NULLIF(n.name, ''), s.name) AS name,
	COALESCE(n.image_url, s.image_url) AS image_url,
	COALESCE(n.origin_dna, s.origin_dna) AS origin_dna,
	COALESCE(n.immutable_data, s.immutable_data) AS immutable_data,
	n.instance_dna,
	n.seed_id, n.instance_number, s.created_tx_id AS seed_tx_id,
	n.max_replicas, n.distributed, n.supply_exhausted,
	n.schema_version, n.previous_owner, n.owner_operation_id,
	n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency, n.listing_expires_at, n.listing_marketplace, n.created_at
`;

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
	const expirationFilter = status === NFT_STATUS_LISTED
		? sql`AND (n.listing_expires_at IS NULL OR n.listing_expires_at > NOW())`
		: sql``;

	const [nfts, counts] = await Promise.all([
		sql<NftListRow[]>`
			SELECT ${LIST_COLUMNS} FROM nfts n LEFT JOIN nfts s ON s.id = n.seed_id
			WHERE n.owner = ${owner} ${statusFilter} ${typeFilter} ${expirationFilter}
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

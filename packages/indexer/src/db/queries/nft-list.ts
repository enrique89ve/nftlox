/**
 * Canonical read path for NFT rows with inheritance resolved.
 *
 * The `nfts` table is normalized: instance rows intentionally leave `name`,
 * `image_url`, and `immutable_data` blank/null (they're inherited from the
 * parent seed), and `origin_dna` lives only on `collections` (pure function
 * of `collection_id`). Any user-facing query that returns an NFT must go
 * through this module, because only here do we `JOIN collections c ON c.id
 * = n.collection_id` and `LEFT JOIN nfts s ON s.id = n.seed_id` — which is
 * what makes an instance row look "complete" to the client.
 *
 * Reading `nfts` directly (without these JOINs) is allowed only for the
 * indexer's own hot paths (state-root scans, counters, handler mutations
 * where we need the raw columns). Do NOT add new user-facing reads here
 * without the JOIN chain — missing metadata on instances is the symptom.
 */
import { sql, type Queryable, clampLimit } from "@/db/client.ts";
import type { NftKind, NftStatus, NftListRow, NftListQuery, UserNftCounts, NftPageResult, Pagination } from "./nft-types.ts";
import { NFT_KIND_INSTANCE, NFT_STATUS_LISTED } from "./nft-types.ts";

const LIST_COLUMNS = sql`
	n.id, n.collection_id, n.nft_type, n.status, n.edition, n.owner,
	COALESCE(NULLIF(n.name, ''), s.name) AS name,
	COALESCE(n.image_url, s.image_url) AS image_url,
	c.origin_dna AS origin_dna,
	COALESCE(n.immutable_data, s.immutable_data) AS immutable_data,
	n.nft_dna,
	n.seed_id, n.instance_number, s.created_tx_id AS seed_tx_id,
	n.max_supply, n.distributed, n.supply_exhausted,
	n.schema_version, n.previous_owner, n.owner_operation_id, n.owner_action, n.owner_block_num::int AS owner_block_num,
	n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency, n.listing_expires_at, n.listing_marketplace, n.created_at
`;

export async function getUserNftCounts(owner: string, txn: Queryable = sql): Promise<UserNftCounts> {
	const [row] = await txn`
		SELECT total, seeds, instances
		FROM owner_nft_counts
		WHERE owner = ${owner}
	`;
	return {
		total: row?.total ?? 0,
		seeds: row?.seeds ?? 0,
		instances: row?.instances ?? 0,
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
		? sql`AND n.nft_type = ${NFT_KIND_INSTANCE} AND (n.listing_expires_at IS NULL OR n.listing_expires_at > NOW())`
		: sql``;

	const [nfts, counts] = await Promise.all([
		sql<NftListRow[]>`
			SELECT ${LIST_COLUMNS} FROM nfts n
			JOIN collections c ON c.id = n.collection_id
			LEFT JOIN nfts s ON s.id = n.seed_id
			WHERE n.owner = ${owner} ${statusFilter} ${typeFilter} ${expirationFilter}
			ORDER BY n.created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
		`,
		getUserNftCounts(owner),
	]);

	return { nfts, counts };
}

// "Raw" in the sense that `name`, `image_url`, and `immutable_data` are
// returned verbatim from the instance row (no COALESCE/fallback to the
// seed). `origin_dna` still JOINs `collections` because it has no copy on
// nfts — that's the single source of truth, not a cache. Callers of this
// helper pair it with `getSeedSummary` to rebuild the full picture
// client-side (compact-mode endpoint).
const RAW_INSTANCE_COLUMNS = sql`
	n.id, n.collection_id, n.nft_type, n.status, n.edition, n.owner,
	n.name, n.image_url, c.origin_dna AS origin_dna, n.immutable_data,
	n.nft_dna,
	n.seed_id, n.instance_number, NULL::text AS seed_tx_id,
	n.max_supply, n.distributed, n.supply_exhausted,
	n.schema_version, n.previous_owner, n.owner_operation_id, n.owner_action, n.owner_block_num::int AS owner_block_num,
	n.listing_id, n.listing_tx_id, n.listing_price, n.listing_currency, n.listing_expires_at, n.listing_marketplace, n.created_at
`;

/** Fetch raw instances (no seed inheritance). Paired with getSeedSummary for compact responses. */
export async function queryRawInstances(seedId: string, page?: Pagination) {
	const safeLimit = clampLimit(page?.limit ?? 50);
	const offset = page?.offset ?? 0;
	return sql<NftListRow[]>`
		SELECT ${RAW_INSTANCE_COLUMNS} FROM nfts n
		JOIN collections c ON c.id = n.collection_id
		WHERE n.seed_id = ${seedId}
		ORDER BY n.instance_number ASC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function queryNfts(query: NftListQuery, page?: Pagination) {
	const safeLimit = clampLimit(page?.limit ?? 50);
	const offset = page?.offset ?? 0;

	switch (query.by) {
		case "owner": {
			const statusFilter = query.status ? sql`AND n.status = ${query.status}` : sql``;
			const typeFilter = query.type ? sql`AND n.nft_type = ${query.type}` : sql``;
			const expirationFilter = query.status === NFT_STATUS_LISTED
				? sql`AND n.nft_type = ${NFT_KIND_INSTANCE} AND (n.listing_expires_at IS NULL OR n.listing_expires_at > NOW())`
				: sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n
				JOIN collections c ON c.id = n.collection_id
				LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.owner = ${query.owner} ${statusFilter} ${typeFilter} ${expirationFilter}
				ORDER BY n.created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "collection": {
			const typeFilter = query.type ? sql`AND n.nft_type = ${query.type}` : sql``;
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n
				JOIN collections c ON c.id = n.collection_id
				LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.collection_id = ${query.collectionId} ${typeFilter}
				ORDER BY n.created_at DESC LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
		case "seed": {
			return sql`
				SELECT ${LIST_COLUMNS} FROM nfts n
				JOIN collections c ON c.id = n.collection_id
				LEFT JOIN nfts s ON s.id = n.seed_id
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
				SELECT ${LIST_COLUMNS} FROM nfts n
				JOIN collections c ON c.id = n.collection_id
				LEFT JOIN nfts s ON s.id = n.seed_id
				WHERE n.status = ${NFT_STATUS_LISTED}
					AND n.nft_type = ${NFT_KIND_INSTANCE}
					${currencyFilter}
					AND (n.listing_expires_at IS NULL OR n.listing_expires_at > NOW())
				ORDER BY ${orderClause}
				LIMIT ${safeLimit} OFFSET ${offset}
			`;
		}
	}
}

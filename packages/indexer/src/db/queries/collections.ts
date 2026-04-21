import { sql, toJsonb, type Queryable, clampLimit } from "@/db/client.ts";
import { NFT_KIND_INSTANCE, NFT_STATUS_LISTED } from "./nft-types.ts";

// A collection row's presence in `collections` IS its "active" state. Archived
// collections are moved to `archived_collections` and removed from `collections`,
// so any row you can SELECT is live — no status column needed.

export interface InsertCollectionParams {
	id: string;
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	maxInstances: number;
	description: string | null;
	imageUrl: string | null;
	externalUrl: string | null;
	transferable: boolean;
	burnable: boolean;
	royaltyPct: number;
	royaltyRecipient: string | null;
	schema: unknown | null;
	schemaVersion: number;
	blockNum: number;
	txId: string;
	createdAt: string;
}

export async function insertCollection(params: InsertCollectionParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO collections (
			id, name, symbol, creator, total_potential, max_instances,
			description, image_url, external_url,
			transferable, burnable, royalty_pct, royalty_recipient,
			schema, schema_version,
			block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.name}, ${params.symbol},
			${params.creator}, ${params.totalPotential}, ${params.maxInstances},
			${params.description}, ${params.imageUrl}, ${params.externalUrl},
			${params.transferable}, ${params.burnable}, ${params.royaltyPct},
			${params.royaltyRecipient},
			${toJsonb(params.schema)}, ${params.schemaVersion},
			${params.blockNum}, ${params.txId},
			${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	return result.count > 0;
}

export async function getCollectionById(id: string): Promise<Record<string, unknown> | null> {
	const [row] = await sql`
		SELECT id, name, symbol, creator, total_potential,
			description, image_url, external_url,
			transferable, burnable, royalty_pct, royalty_recipient,
			schema, schema_version, tx_id, created_at
		FROM collections
		WHERE id = ${id}
	`;
	return row ?? null;
}

export interface CollectionRulesRow {
	id: string;
	creator: string;
	total_potential: number;
	seed_count: number;
	// True once any seed has ever been minted in this collection — even if all
	// seeds were later burned. Backed by: seeds>0 OR EXISTS burned_nfts.
	// Used by extend_schema to freeze the immutable namespace permanently,
	// closing the mint→burn→extend→remint bypass.
	has_minted: boolean;
	transferable: boolean;
	burnable: boolean;
	royalty_pct: string;
	royalty_recipient: string | null;
	schema: unknown | null;
	schema_version: number;
}

export interface CollectionArchiveSnapshotRow {
	id: string;
	creator: string;
	nft_count: number;
}

export async function getCollectionRules(
	id: string,
	txn: Queryable = sql,
): Promise<CollectionRulesRow | null> {
	const [row] = await txn<CollectionRulesRow[]>`
		SELECT c.id, c.creator, c.total_potential, c.transferable,
			c.burnable, c.royalty_pct, c.royalty_recipient,
			c.schema, c.schema_version,
			COALESCE(cs.seeds, 0)::int AS seed_count,
			(
				COALESCE(cs.seeds, 0) > 0
				OR EXISTS (SELECT 1 FROM burned_nfts bn WHERE bn.collection_id = c.id)
			) AS has_minted
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.id = ${id}
	`;
	return row ?? null;
}

export async function getCollectionArchiveSnapshot(
	id: string,
	txn: Queryable = sql,
): Promise<CollectionArchiveSnapshotRow | null> {
	const [row] = await txn<CollectionArchiveSnapshotRow[]>`
		SELECT
			c.id,
			c.creator,
			COALESCE(cs.total, 0)::int AS nft_count
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.id = ${id}
	`;
	return row ?? null;
}

export async function updateCollectionSchema(
	collectionId: string,
	schema: unknown,
	schemaVersion: number,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE collections
		SET schema = ${toJsonb(schema)}, schema_version = ${schemaVersion}
		WHERE id = ${collectionId}
	`;
}

export async function archiveCollection(
	collectionId: string,
	creator: string,
	txId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO archived_collections (id, creator, tx_id)
		VALUES (${collectionId}, ${creator}, ${txId})
		ON CONFLICT (id) DO NOTHING
	`;
	// ON DELETE CASCADE cleans: collection_stats, schema_versions,
	// collection_allowances, data_operators
	await txn`DELETE FROM collections WHERE id = ${collectionId}`;
}

export async function collectionExists(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM collections WHERE id = ${id}`;
	return !!row;
}

export async function symbolTakenByCreator(creator: string, symbol: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM collections WHERE creator = ${creator} AND symbol = ${symbol}`;
	return !!row;
}

export async function countCollectionsByCreator(creator: string, txn: Queryable = sql): Promise<number> {
	const [row] = await txn`SELECT COUNT(*)::int AS count FROM collections WHERE creator = ${creator}`;
	return row?.count ?? 0;
}

// Per-creator aggregates over collection_stats. Bounded by collectionsPerCreator
// (currently 50), so the JOIN scans at most that many rows per call. The
// (creator, symbol) unique index on collections makes the lookup index-only.
export async function countSeedsByCreator(creator: string, txn: Queryable = sql): Promise<number> {
	const [row] = await txn`
		SELECT COALESCE(SUM(cs.seeds), 0)::int AS count
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.creator = ${creator}
	`;
	return row?.count ?? 0;
}

export async function countInstancesByCreator(creator: string, txn: Queryable = sql): Promise<number> {
	const [row] = await txn`
		SELECT COALESCE(SUM(cs.instances), 0)::int AS count
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.creator = ${creator}
	`;
	return row?.count ?? 0;
}

// Current materialized instance count for a single collection. Used by the
// per-collection cap check inside bulk_distribute. `collection_stats` is
// maintained explicitly (see nft-counters.ts), so this returns the same value
// the next mint would observe.
export async function countInstancesByCollection(
	collectionId: string,
	txn: Queryable = sql,
): Promise<number> {
	const [row] = await txn`
		SELECT COALESCE(instances, 0)::int AS count
		FROM collection_stats
		WHERE collection_id = ${collectionId}
	`;
	return row?.count ?? 0;
}

const COLLECTION_LIST_COLUMNS = sql`
	c.id, c.name, c.symbol, c.creator, c.total_potential,
	c.description, c.image_url, c.external_url,
	c.transferable, c.burnable, c.royalty_pct, c.royalty_recipient,
	c.schema_version, c.tx_id, c.created_at,
	COALESCE(cs.seeds, 0)::int AS seed_count,
	COALESCE(cs.instances, 0)::int AS instance_count
`;

export async function listCollections(limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT ${COLLECTION_LIST_COLUMNS}
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		ORDER BY c.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getCollectionsByCreator(creator: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT ${COLLECTION_LIST_COLUMNS}
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.creator = ${creator}
		ORDER BY c.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getCollectionStats(collectionId: string) {
	const [stats] = await sql`
		SELECT
			COALESCE(cs.seeds, 0) AS total_seeds,
			COALESCE(cs.instances, 0) AS total_instances,
			COALESCE((
				SELECT COUNT(*) FROM nfts
				WHERE collection_id = ${collectionId}
					AND nft_type = ${NFT_KIND_INSTANCE}
					AND status = ${NFT_STATUS_LISTED}
					AND (listing_expires_at IS NULL OR listing_expires_at > NOW())
			), 0)::int AS total_listed,
			COALESCE(cs.burned, 0) AS total_burned,
			COALESCE((SELECT COUNT(DISTINCT owner) FROM nfts WHERE collection_id = ${collectionId}), 0)::int AS unique_owners,
			(
				SELECT MIN(listing_price) FROM nfts
				WHERE collection_id = ${collectionId}
					AND nft_type = ${NFT_KIND_INSTANCE}
					AND status = ${NFT_STATUS_LISTED}
					AND (listing_expires_at IS NULL OR listing_expires_at > NOW())
			) AS floor_price
		FROM collection_stats cs
		WHERE cs.collection_id = ${collectionId}
	`;
	return stats ?? {
		total_seeds: 0, total_instances: 0,
		total_listed: 0, total_burned: 0, unique_owners: 0, floor_price: null,
	};
}

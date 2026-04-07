import { sql, type Queryable, clampLimit } from "@/db/client.ts";

export const COLLECTION_STATUS_ACTIVE = "active";
export const COLLECTION_STATUS_ARCHIVED = "archived";
export type CollectionStatus =
	| typeof COLLECTION_STATUS_ACTIVE
	| typeof COLLECTION_STATUS_ARCHIVED;

export interface InsertCollectionParams {
	id: string;
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	description: string | null;
	imageUrl: string | null;
	externalUrl: string | null;
	transferable: boolean;
	burnable: boolean;
	replicable: boolean;
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
			id, name, symbol, creator, total_potential,
			description, image_url, external_url,
			transferable, burnable, replicable, royalty_pct, royalty_recipient,
			schema, schema_version,
			block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.name}, ${params.symbol},
			${params.creator}, ${params.totalPotential},
			${params.description}, ${params.imageUrl}, ${params.externalUrl},
			${params.transferable}, ${params.burnable}, ${params.replicable}, ${params.royaltyPct},
			${params.royaltyRecipient},
			${params.schema ? JSON.stringify(params.schema) : null}, ${params.schemaVersion},
			${params.blockNum}, ${params.txId},
			${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	return result.count > 0;
}

export async function getCollectionById(id: string): Promise<Record<string, unknown> | null> {
	const [row] = await sql`
		SELECT * FROM collections
		WHERE id = ${id} AND status = ${COLLECTION_STATUS_ACTIVE}
	`;
	return row ?? null;
}

export interface CollectionRulesRow {
	id: string;
	creator: string;
	total_potential: number;
	seed_count: number;
	status: CollectionStatus;
	transferable: boolean;
	burnable: boolean;
	replicable: boolean;
	royalty_pct: string;
	royalty_recipient: string | null;
	schema: unknown | null;
	schema_version: number;
}

export interface CollectionArchiveSnapshotRow {
	id: string;
	creator: string;
	status: CollectionStatus;
	nft_count: number;
	pack_count: number;
}

export async function getCollectionRules(
	id: string,
	txn: Queryable = sql,
): Promise<CollectionRulesRow | null> {
	const [row] = await txn<CollectionRulesRow[]>`
		SELECT c.id, c.creator, c.total_potential, c.status, c.transferable,
			c.burnable, c.replicable, c.royalty_pct, c.royalty_recipient,
			c.schema, c.schema_version,
			COALESCE(cs.seeds, 0)::int AS seed_count
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
			c.status,
			COALESCE(cs.total, 0)::int AS nft_count,
			COALESCE((SELECT COUNT(*)::int FROM packs p WHERE p.collection_id = c.id), 0) AS pack_count
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
		SET schema = ${JSON.stringify(schema)}, schema_version = ${schemaVersion}
		WHERE id = ${collectionId}
	`;
}

export async function archiveCollection(
	collectionId: string,
	blockNum: number,
	txId: string,
	archivedAt: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE collections
		SET status = ${COLLECTION_STATUS_ARCHIVED},
			archived_at_block = ${blockNum},
			archived_tx_id = ${txId},
			archived_at = ${archivedAt}
		WHERE id = ${collectionId}
	`;
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

export async function listCollections(limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT c.*,
			COALESCE(cs.seeds, 0) AS seed_count,
			COALESCE(cs.instances, 0) AS instance_count
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.status = ${COLLECTION_STATUS_ACTIVE}
		ORDER BY c.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getCollectionsByCreator(creator: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT c.*,
			COALESCE(cs.seeds, 0) AS seed_count,
			COALESCE(cs.instances, 0) AS instance_count
		FROM collections c
		LEFT JOIN collection_stats cs ON cs.collection_id = c.id
		WHERE c.creator = ${creator} AND c.status = ${COLLECTION_STATUS_ACTIVE}
		ORDER BY c.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getCollectionStats(collectionId: string) {
	const [stats] = await sql`
		SELECT
			COALESCE(cs.seeds, 0) AS total_seeds,
			COALESCE(cs.instances, 0) AS total_instances,
			COALESCE(cs.replicas, 0) AS total_replicas,
			COALESCE(cs.listed, 0) AS total_listed,
			COALESCE(cs.burned, 0) AS total_burned,
			COALESCE((SELECT COUNT(DISTINCT owner) FROM nfts WHERE collection_id = ${collectionId} AND status != 'burned'), 0) AS unique_owners,
			(SELECT MIN(listing_price) FROM nfts WHERE collection_id = ${collectionId} AND status = 'listed' AND (listing_expires_at IS NULL OR listing_expires_at > NOW())) AS floor_price
		FROM collection_stats cs
		WHERE cs.collection_id = ${collectionId}
	`;
	return stats ?? {
		total_seeds: 0, total_instances: 0, total_replicas: 0,
		total_listed: 0, total_burned: 0, unique_owners: 0, floor_price: null,
	};
}

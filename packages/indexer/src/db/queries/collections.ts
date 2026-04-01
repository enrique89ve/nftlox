import { sql, type Queryable, clampLimit } from "@/db/client.ts";

export const COLLECTION_STATUS_ACTIVE = "active";
export const COLLECTION_STATUS_ARCHIVED = "archived";
export type CollectionStatus =
	| typeof COLLECTION_STATUS_ACTIVE
	| typeof COLLECTION_STATUS_ARCHIVED;

export interface InsertCollectionParams {
	id: string;
	jsonId: string | null;
	name: string;
	symbol: string;
	creator: string;
	totalPotential: number;
	originDna: string | null;
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
			id, json_id, name, symbol, creator, total_potential,
			origin_dna, description, image_url, external_url,
			transferable, burnable, replicable, royalty_pct, royalty_recipient,
			schema, schema_version,
			block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.jsonId}, ${params.name}, ${params.symbol},
			${params.creator}, ${params.totalPotential}, ${params.originDna},
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
	royalty_pct: number;
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
			COALESCE(COUNT(n.id) FILTER (WHERE n.nft_type = 'seed'), 0)::int AS seed_count
		FROM collections c
		LEFT JOIN nfts n ON n.collection_id = c.id
		WHERE c.id = ${id}
		GROUP BY c.id
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
			COALESCE((SELECT COUNT(*)::int FROM nfts n WHERE n.collection_id = c.id), 0) AS nft_count,
			COALESCE((SELECT COUNT(*)::int FROM packs p WHERE p.collection_id = c.id), 0) AS pack_count
		FROM collections c
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

export async function listCollections(limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT c.*,
			COALESCE(COUNT(*) FILTER (WHERE n.nft_type = 'seed'), 0) AS seed_count,
			COALESCE(COUNT(*) FILTER (WHERE n.nft_type = 'instance'), 0) AS instance_count
		FROM collections c
		LEFT JOIN nfts n ON n.collection_id = c.id
		WHERE c.status = ${COLLECTION_STATUS_ACTIVE}
		GROUP BY c.id
		ORDER BY c.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getCollectionsByCreator(creator: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT c.*,
			COALESCE(COUNT(*) FILTER (WHERE n.nft_type = 'seed'), 0) AS seed_count,
			COALESCE(COUNT(*) FILTER (WHERE n.nft_type = 'instance'), 0) AS instance_count
		FROM collections c
		LEFT JOIN nfts n ON n.collection_id = c.id
		WHERE c.creator = ${creator} AND c.status = ${COLLECTION_STATUS_ACTIVE}
		GROUP BY c.id
		ORDER BY c.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getCollectionStats(collectionId: string) {
	const [stats] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE nft_type = 'seed') AS total_seeds,
			COUNT(*) FILTER (WHERE nft_type = 'instance') AS total_instances,
			COUNT(*) FILTER (WHERE nft_type = 'replica') AS total_replicas,
			COUNT(*) FILTER (WHERE status = 'listed') AS total_listed,
			COUNT(*) FILTER (WHERE status = 'burned') AS total_burned,
			COUNT(DISTINCT owner) AS unique_owners,
			MIN(listing_price) FILTER (WHERE status = 'listed') AS floor_price
		FROM nfts
		WHERE collection_id = ${collectionId}
	`;
	return stats;
}

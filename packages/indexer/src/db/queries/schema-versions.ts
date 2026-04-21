import { sql, toJsonb, type Queryable } from "@/db/client.ts";

export interface InsertSchemaVersionParams {
	collectionId: string;
	version: number;
	schema: unknown;
	schemaHash: string;
	prevHash: string | null;
	blockNum: number;
	txId: string;
	createdAt: string;
}

export async function insertSchemaVersion(params: InsertSchemaVersionParams, txn: Queryable = sql): Promise<void> {
	const result = await txn`
		INSERT INTO schema_versions (
			collection_id, version, schema, schema_hash, prev_hash,
			block_num, tx_id, created_at
		) VALUES (
			${params.collectionId}, ${params.version},
			${toJsonb(params.schema)}, ${params.schemaHash}, ${params.prevHash},
			${params.blockNum}, ${params.txId}, ${params.createdAt}
		)
	`;
	if (result.count === 0) {
		throw new Error(
			`Failed to insert schema version ${params.version} for collection ${params.collectionId} — row already exists`,
		);
	}
}

export async function getLatestSchemaVersion(
	collectionId: string,
	txn: Queryable = sql,
): Promise<{ version: number; schema_hash: string } | null> {
	const [row] = await txn<{ version: number; schema_hash: string }[]>`
		SELECT version, schema_hash
		FROM schema_versions
		WHERE collection_id = ${collectionId}
		ORDER BY version DESC
		LIMIT 1
	`;
	return row ?? null;
}

export async function getSchemaChain(collectionId: string) {
	return sql`
		SELECT version, schema, schema_hash, prev_hash, block_num, tx_id, created_at
		FROM schema_versions
		WHERE collection_id = ${collectionId}
		ORDER BY version ASC
	`;
}

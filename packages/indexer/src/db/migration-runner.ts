import { sql } from "./client.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("migration-runner");

const SCHEMA_MIGRATION_ERROR_NAME = "NftloxSchemaMigrationError";

type LegacySchemaColumn = Readonly<{
	table_name: string;
	column_name: string;
}>;

/**
 * Returns true for a schema incompatibility that cannot be fixed by retrying
 * the database connection. The development migration policy requires a clean
 * reset when the old NFT projection is present; retrying would only hide that
 * operator action behind an infinite backoff loop.
 */
export function isSchemaMigrationError(error: unknown): error is Error {
	return error instanceof Error && error.name === SCHEMA_MIGRATION_ERROR_NAME;
}

function createLegacySchemaError(markers: readonly LegacySchemaColumn[]): Error {
	const details = markers.slice(0, 5).map((marker) => `${marker.table_name}.${marker.column_name}`);
	const suffix = markers.length > details.length ? ` (+${markers.length - details.length} more)` : "";
	const error = new Error(
		`Legacy NFT schema detected (${details.join(", ")}${suffix}). ` +
		"This Asset migration uses a clean development baseline; run " +
		"packages/indexer/scripts/reset_db.sh and replay from genesis before starting the indexer.",
	);
	error.name = SCHEMA_MIGRATION_ERROR_NAME;
	return error;
}

async function assertCompatibleSchema(): Promise<void> {
	// The migration is intentionally a baseline, not an in-place NFT→Asset
	// converter. Detect legacy names before executing any DDL so a failed boot
	// cannot leave a partially mixed projection behind.
	const markers = await sql<LegacySchemaColumn[]>`
		SELECT table_name, column_name
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND (table_name LIKE 'nft%' OR column_name LIKE 'nft%')
		ORDER BY table_name, column_name
		LIMIT 25
	`;
	if (markers.length > 0) throw createLegacySchemaError(markers);
}

async function getSchemaPath(): Promise<string> {
	const candidates = [
		"/app/packages/indexer/db/schema.sql",
		"/app/src/db/schema.sql",
		import.meta.dir + "/schema.sql",
	];

	for (const path of candidates) {
		const exists = await Bun.file(path).exists();
		if (exists) {
			log.info(`Using schema file: ${path}`);
			return path;
		}
	}

	throw new Error(`schema.sql not found. Tried: ${candidates.join(", ")}`);
}

export async function runMigrations(): Promise<void> {
	log.info("Initializing database schema");
	await assertCompatibleSchema();

	const schemaPath = await getSchemaPath();
	const schemaFile = Bun.file(schemaPath);
	const schemaText = await schemaFile.text();

	try {
		await sql.unsafe(schemaText);
		log.info("Database schema initialized successfully");
	} catch (err) {
		log.error("Failed to initialize schema", err);
		throw err;
	}
}

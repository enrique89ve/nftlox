import { sql } from "./client.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("migration-runner");

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

	const schemaPath = await getSchemaPath();
	const schemaFile = Bun.file(schemaPath);
	const schemaText = await schemaFile.text();

	try {
		await sql.unsafe(schemaText);
		log.info("Database schema initialized successfully");
	} catch (err) {
		const isAlreadyExists = err instanceof Error && err.message.includes("already exists");
		if (isAlreadyExists) {
			log.info("Schema already initialized, skipping");
			return;
		}
		log.error("Failed to initialize schema", err);
		throw err;
	}
}

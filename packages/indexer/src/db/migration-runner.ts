import { sql, withTransaction } from "./client.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("migration-runner");

async function getSchemaPath(): Promise<string> {
	let path = import.meta.dir + "/schema.sql";
	if (!await Bun.file(path).exists()) {
		path = "/app/packages/indexer/db/schema.sql";
	}
	if (!await Bun.file(path).exists()) {
		throw new Error("schema.sql not found");
	}
	return path;
}

async function getMigrationsPath(): Promise<string> {
	let path = import.meta.dir + "/migrations";
	if (!await Bun.file(path).exists()) {
		path = "/app/packages/indexer/db/migrations";
	}
	if (!await Bun.file(path).exists()) {
		throw new Error("migrations directory not found");
	}
	return path;
}

async function computeChecksum(content: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	return Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
}

async function ensureSchemaMigrationsTable(): Promise<void> {
	const schemaPath = await getSchemaPath();
	const schemaFile = Bun.file(schemaPath);
	const schemaText = await schemaFile.text();

	try {
		await sql.unsafe(schemaText);
	} catch (err) {
		log.error("Failed to initialize schema", err);
		throw err;
	}
}

export async function runMigrations(): Promise<void> {
	log.info("Starting migration runner");

	await ensureSchemaMigrationsTable();

	const migrationsPath = await getMigrationsPath();
	const migrationsDir = Bun.file(migrationsPath);

	const migrationFiles: string[] = [];
	for await (const file of migrationsDir.exists() ? migrationsDir.listFiles() : []) {
		const name = file.name;
		if (name.endsWith(".sql")) {
			migrationFiles.push(name);
		}
	}

	migrationFiles.sort();

	if (migrationFiles.length === 0) {
		log.info("No migrations found");
		return;
	}

	const appliedMigrations = new Set<string>();
	try {
		const rows = await sql`SELECT version FROM schema_migrations`;
		rows.forEach(row => appliedMigrations.add(row.version as string));
	} catch {
		log.info("schema_migrations table not yet available, will initialize");
	}

	for (const filename of migrationFiles) {
		const version = filename.replace(/\.sql$/, "");

		if (appliedMigrations.has(version)) {
			log.info(`Migration ${version} already applied, skipping`);
			continue;
		}

		const migrationFile = Bun.file(`${migrationsPath}/${filename}`);
		const content = await migrationFile.text();
		const checksum = await computeChecksum(content);

		log.info(`Applying migration ${version}`);

		await withTransaction(async (txn) => {
			try {
				await txn.unsafe(content);
				await txn`
					INSERT INTO schema_migrations (version, checksum)
					VALUES (${version}, ${checksum})
					ON CONFLICT (version) DO NOTHING
				`;
				log.info(`Migration ${version} applied successfully`);
			} catch (err) {
				log.error(`Migration ${version} failed`, err);
				throw err;
			}
		});
	}

	log.info("All pending migrations applied successfully");
}

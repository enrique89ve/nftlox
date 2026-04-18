import { runMigrations } from "./db/migration-runner.ts";
import { sql } from "./db/client.ts";

const log = console;

try {
	log.log("Starting migrations...");
	await runMigrations();
	log.log("✓ All migrations applied successfully");
	process.exit(0);
} catch (err) {
	log.error("Migration failed:", err);
	process.exit(1);
} finally {
	await sql.end();
}

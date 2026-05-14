import { runMigrations } from "./db/migration-runner.ts";
import { sql } from "./db/client.ts";

const log = console;

try {
	log.log("Applying schema baseline...");
	await runMigrations();
	log.log("✓ Schema baseline applied successfully");
	process.exit(0);
} catch (err) {
	log.error("Schema install failed:", err);
	process.exit(1);
} finally {
	await sql.end();
}

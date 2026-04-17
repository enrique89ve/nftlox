import { testConnection, sql, withTransaction } from "./db/client.ts";
import { cleanupInvalidMarketplaceListings } from "./db/queries/nfts.ts";
import { bootstrapStateRootFromFullScan, getStateMeta } from "./db/queries/state-root.ts";
import { emptyStateRoot, rootsEqual } from "./utils/state-root-hash.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";

const log = createLogger("bootstrap");

async function runCmd(cmd: string[]): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout };
}

async function ensurePostgres(): Promise<void> {
	const { stdout } = await runCmd(["docker", "ps", "-q", "-f", "name=nftlox-postgres"]);
	if (stdout.trim()) return;

	log.info("Starting PostgreSQL...");
	const schemaPath = import.meta.dir + "/../src/db/schema.sql";

	await runCmd(["docker", "rm", "-f", "nftlox-postgres"]);
	const { exitCode } = await runCmd([
		"docker", "run", "-d",
		"--name", "nftlox-postgres",
		"-e", `POSTGRES_DB=${config.postgresDb}`,
		"-e", `POSTGRES_USER=${config.postgresUser}`,
		"-e", `POSTGRES_PASSWORD=${config.postgresPassword}`,
		"-p", "5432:5432",
		"-v", `${schemaPath}:/docker-entrypoint-initdb.d/001-schema.sql`,
		"postgres:16-alpine",
	]);

	if (exitCode !== 0) throw new Error("Failed to start PostgreSQL container");

	log.info("Waiting for PostgreSQL to be ready...");
	for (let i = 0; i < 30; i++) {
		try {
			await testConnection();
			return;
		} catch {
			await new Promise(r => setTimeout(r, 1000));
		}
	}
	throw new Error("PostgreSQL failed to start within 30s");
}

let cachedSchemaSql: string | null = null;
let cachedSchemaHash: string | null = null;

async function loadSchema(): Promise<{ sql: string; hash: string }> {
	if (cachedSchemaSql !== null && cachedSchemaHash !== null) {
		return { sql: cachedSchemaSql, hash: cachedSchemaHash };
	}
	// In bundle: schema is at /app/packages/indexer/db/schema.sql
	// In dev: schema is at ./db/schema.sql relative to src/bootstrap.ts
	let schemaPath = import.meta.dir + "/db/schema.sql";
	if (!await Bun.file(schemaPath).exists()) {
		schemaPath = "/app/packages/indexer/db/schema.sql";
	}
	const schemaFile = Bun.file(schemaPath);
	if (!await schemaFile.exists()) {
		throw new Error("Schema file not found — cannot initialize database", {
			cause: { path: schemaFile.name },
		});
	}
	const text = await schemaFile.text();
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	cachedSchemaSql = text;
	cachedSchemaHash = `sha256:${hex}`;
	return { sql: text, hash: cachedSchemaHash };
}

async function runMigrations(): Promise<void> {
	log.info("Running schema migrations...");
	const { sql: schemaText } = await loadSchema();
	await sql.unsafe(schemaText);
	log.info("Schema migrations completed");
}

// Singletons are reset in-place via UPDATE. TRUNCATE'ing them would wipe the
// id=1 row and break the subsequent UPDATE ... WHERE id = 1 (0 rows affected).
// Every new singleton MUST be added here AND have an explicit reset UPDATE in
// wipeAllProjectedData below.
export const STATE_SINGLETONS: ReadonlySet<string> = new Set(["state_meta", "sync_state"]);

// Builds the TRUNCATE statement that wipes every projected table in one shot.
// Pure so it can be unit-tested without a live DB. Returns null when the
// schema has no non-singleton tables — caller treats that as "install not
// run" and throws, which is the correct failure mode for a wipe over an
// empty schema (we'd mask a broken install otherwise).
export function buildProjectionTruncateStmt(allTableNames: readonly string[]): string | null {
	const targets = allTableNames.filter((name) => !STATE_SINGLETONS.has(name));
	if (targets.length === 0) return null;
	const quoted = targets.map(quoteSqlIdentifier).join(", ");
	return `TRUNCATE TABLE ${quoted} CASCADE`;
}

// Defensive identifier quoting. information_schema returns valid PG
// identifiers, but we still quote + escape embedded double-quotes so a
// future code path that feeds untrusted names through here cannot inject
// SQL. Identical semantics to PostgreSQL's quote_ident().
function quoteSqlIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

// Shared by every reset trigger (genesis change, schema drift). Truncates all
// projected data and zeroes the singletons in a single transaction so the
// sync cursor cannot advance over a half-wiped DB.
//
// Table list is queried at runtime from information_schema — adding a new
// projected table to schema.sql is picked up automatically on the next
// reset. This eliminates the drift class where a manual list forgets a new
// table and leaves orphan rows after a schema-hash bump.
async function wipeAllProjectedData(newSchemaHash: string | null): Promise<void> {
	await withTransaction(async (txn) => {
		const rows = await txn<{ table_name: string }[]>`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
			  AND table_type = 'BASE TABLE'
		`;
		const stmt = buildProjectionTruncateStmt(rows.map((r) => r.table_name));
		if (stmt === null) {
			throw new Error(
				"wipeAllProjectedData: no non-singleton tables found in schema 'public' — schema install did not run",
			);
		}
		await txn.unsafe(stmt);
		await txn`
			UPDATE sync_state
			SET last_block = 0,
			    genesis_block = ${config.genesisBlock},
			    schema_hash = ${newSchemaHash},
			    updated_at = NOW()
		`;
		// Reset state_meta in-place (TRUNCATE + re-seed would race the singleton).
		await txn`
			UPDATE state_meta
			SET state_root = decode(repeat('00', 32), 'hex'),
			    nft_count = 0,
			    last_block_num = 0,
			    updated_at = NOW()
			WHERE id = 1
		`;
	});
}

async function checkGenesisReset(): Promise<void> {
	const [row] = await sql`SELECT genesis_block FROM sync_state WHERE id = 1`;
	const raw = row?.genesis_block ?? 0;
	const storedGenesis = Number.isFinite(Number(raw)) ? Number(raw) : 0;

	if (storedGenesis === config.genesisBlock) return;

	if (storedGenesis === 0) {
		await sql`UPDATE sync_state SET genesis_block = ${config.genesisBlock}`;
		log.info("Genesis block stored", { genesisBlock: config.genesisBlock });
		return;
	}

	log.warn("GENESIS BLOCK CHANGED — resetting all data", {
		previous: storedGenesis,
		current: config.genesisBlock,
	});
	const { hash } = await loadSchema();
	await wipeAllProjectedData(hash);
	log.info("Database reset completed — syncing from new genesis block");
}

// Testnet policy: any change to schema.sql triggers a full projection wipe and
// re-sync from genesis. We don't carry a migration chain — the chain is the
// Hive blockchain itself, and re-indexing from genesis is deterministic.
//
// First-run (stored_hash == NULL) just records the current hash without a wipe
// — there's no data to be inconsistent with a new schema.
async function checkSchemaHashReset(): Promise<void> {
	const { hash } = await loadSchema();
	const [row] = await sql`SELECT schema_hash FROM sync_state WHERE id = 1`;
	const stored = row?.schema_hash ?? null;

	if (stored === hash) return;

	if (stored === null) {
		await sql`UPDATE sync_state SET schema_hash = ${hash}, updated_at = NOW() WHERE id = 1`;
		log.info("Schema hash initialized", { hash });
		return;
	}

	log.warn("SCHEMA HASH CHANGED — resetting all data (testnet policy)", {
		previous: stored,
		current: hash,
	});
	await wipeAllProjectedData(hash);
	log.info("Database reset completed — re-syncing under new schema");
}

async function cleanupMarketplaceListings(): Promise<void> {
	const result = await withTransaction((txn) => cleanupInvalidMarketplaceListings(txn));
	if (result.clearedListings === 0 && result.reconciledCollections === 0) return;

	log.info("Marketplace listings reconciled", result);
}

// Rebuilds state_meta from a full nft scan when the singleton is still zero
// but rows already exist — the case for indexers upgraded from a version that
// didn't track the incremental root. Safe to run on every boot: when the
// root is already populated, this no-ops in O(1).
async function ensureStateRootBootstrapped(): Promise<void> {
	const meta = await getStateMeta();
	if (!rootsEqual(meta.state_root, emptyStateRoot())) return;
	const [countRow] = await sql`SELECT COUNT(*)::bigint AS c FROM nfts`;
	const nftCount = Number(countRow?.c ?? 0);
	if (nftCount === 0) return;

	log.info("Bootstrapping state_meta from nft full-scan", { nftCount });
	const rebuilt = await withTransaction((txn) => bootstrapStateRootFromFullScan(txn));
	log.info("state_meta bootstrapped", {
		nft_count: rebuilt.nft_count,
		last_block_num: rebuilt.last_block_num,
	});
}

export async function connectWithRetry(): Promise<void> {
	let attempt = 0;
	while (true) {
		try {
			attempt++;
			// Only start local Postgres if DATABASE_URL is not configured.
			// Production (external DB) sets DATABASE_URL; dev mode relies on local container.
			if (!config.databaseUrl) {
				await ensurePostgres();
			}
			await testConnection();
			await runMigrations();
			await checkSchemaHashReset();
			await checkGenesisReset();
			await cleanupMarketplaceListings();
			await ensureStateRootBootstrapped();
			return;
		} catch (err) {
			if (attempt === 1) log.info("Waiting for database...");
			const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
			log.error(`Database connection failed (attempt ${attempt}), retrying in ${delay}ms`, {
				error: err instanceof Error ? err.message : String(err),
			});
			await new Promise(r => setTimeout(r, delay));
		}
	}
}

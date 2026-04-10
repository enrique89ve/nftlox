import { testConnection, sql, withTransaction } from "./db/client.ts";
import { cleanupInvalidMarketplaceListings } from "./db/queries/nfts.ts";
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

async function runMigrations(): Promise<void> {
	log.info("Running schema migrations...");
	const schemaFile = Bun.file(import.meta.dir + "/db/schema.sql");
	if (!await schemaFile.exists()) {
		throw new Error("Schema file not found — cannot initialize database", {
			cause: { path: schemaFile.name },
		});
	}
	await sql.unsafe(await schemaFile.text());
	log.info("Schema migrations completed");
}

// Ordered by foreign key dependencies (children first)
const DATA_TABLES = [
	"nft_loans", "nft_allowances", "collection_allowances",
	"data_operators",
	"orphaned_buys", "invalid_operations", "owner_nft_counts",
	"collection_stats",
	"nfts", "collections",
] as const;

async function checkGenesisReset(): Promise<void> {
	const [row] = await sql`SELECT genesis_block FROM sync_state WHERE id = 1`;
	const storedGenesis = Number(row?.genesis_block ?? 0);

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

	await withTransaction(async (txn) => {
		for (const table of DATA_TABLES) {
			await txn.unsafe(`TRUNCATE TABLE ${table} CASCADE`);
		}
		await txn`
			UPDATE sync_state
			SET last_block = 0, genesis_block = ${config.genesisBlock}, updated_at = NOW()
		`;
	});

	log.info("Database reset completed — syncing from new genesis block");
}

async function cleanupMarketplaceListings(): Promise<void> {
	const result = await withTransaction((txn) => cleanupInvalidMarketplaceListings(txn));
	if (result.clearedListings === 0 && result.reconciledCollections === 0) return;

	log.info("Marketplace listings reconciled", result);
}

export async function connectWithRetry(): Promise<void> {
	let attempt = 0;
	while (true) {
		try {
			attempt++;
			if (config.nodeEnv !== "production") {
				await ensurePostgres();
			}
			await testConnection();
			await runMigrations();
			await checkGenesisReset();
			await cleanupMarketplaceListings();
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

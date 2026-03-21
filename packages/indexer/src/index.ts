import { testConnection, closePool } from "./db/client.ts";
import { startSync, stopSync } from "./scanner/sync-engine.ts";
import { startApiServer } from "./api/server.ts";
import { setStartupTime, getSyncProgress, isSynced } from "./scanner/sync-state.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";

const log = createLogger("main");

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

async function connectWithRetry(): Promise<void> {
	let attempt = 0;
	while (true) {
		try {
			attempt++;
			if (config.nodeEnv !== "production") {
				await ensurePostgres();
			}
			await testConnection();
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

async function main(): Promise<void> {
	setStartupTime();
	log.info("NFTLox Indexer starting...");

	await connectWithRetry();

	startApiServer();

	if (config.healthPort > 0) {
		Bun.serve({
			port: config.healthPort,
			fetch() {
				const progress = getSyncProgress();
				const synced = isSynced();
				return new Response(
					JSON.stringify({ status: synced ? "ok" : "syncing", ...progress }),
					{
						status: synced ? 200 : 503,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});
		log.info(`Static health endpoint on port ${config.healthPort}`);
	}

	startSync();
}

process.on("SIGINT", async () => {
	log.info("Shutting down...");
	stopSync();
	await closePool();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	log.info("Shutting down...");
	stopSync();
	await closePool();
	process.exit(0);
});

main().catch((err) => {
	log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});

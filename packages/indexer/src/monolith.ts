import { closePool } from "./db/client.ts";
import { startSync, stopSync } from "./scanner/sync-engine.ts";
import { startApiServer } from "./api/server.ts";
import { setStartupTime, getSyncProgress, isSynced } from "./scanner/sync-state.ts";
import { connectWithRetry } from "./bootstrap.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";

const log = createLogger("monolith");

async function main(): Promise<void> {
	setStartupTime();
	log.info("NFTLox Indexer starting (monolith)...");

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

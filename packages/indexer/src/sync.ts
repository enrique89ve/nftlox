import { closePool } from "./db/client.ts";
import { startSync, stopSync } from "./scanner/sync-engine.ts";
import { setStartupTime, getSyncProgress, isSynced } from "./scanner/sync-state.ts";
import { connectWithRetry } from "./bootstrap.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";
import { dns } from "bun";

const log = createLogger("sync");

process.on("unhandledRejection", (err) => {
	log.error("Unhandled rejection", { error: err instanceof Error ? err.message : String(err) });
});

process.on("uncaughtException", (err) => {
	log.error("Uncaught exception — shutting down", { error: err.message });
	process.exit(1);
});



async function main(): Promise<void> {
	setStartupTime();
	log.info("NFTLox Sync Engine starting...");

	await connectWithRetry();

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

	// Pre-resolve DNS for Hive endpoints
	for (const endpoint of config.hiveEndpoints) {
		try {
			const url = new URL(endpoint);
			dns.prefetch(url.hostname, Number(url.port) || 443);
		} catch { /* invalid URL handled elsewhere */ }
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

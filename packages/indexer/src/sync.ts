import { closePool } from "./db/client.ts";
import { startSync, stopSync } from "./scanner/sync-engine.ts";
import { setStartupTime } from "./scanner/sync-state.ts";
import { connectWithRetry } from "./bootstrap.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";
import { dns } from "bun";
import { buildInternalHealthResponse } from "./health/internal-health.ts";

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
			fetch(request) {
				return buildInternalHealthResponse(request);
			},
		});
		log.info(`Internal health endpoints on port ${config.healthPort}`);
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
	await stopSync();
	await closePool();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	log.info("Shutting down...");
	await stopSync();
	await closePool();
	process.exit(0);
});

main().catch((err) => {
	log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});

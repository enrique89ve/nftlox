import { closePool } from "./db/client.ts";
import { startApiServer, stopPolling } from "./api/server.ts";
import { connectWithRetry } from "./bootstrap.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("api");

async function main(): Promise<void> {
	log.info("NFTLox API Server starting...");

	await connectWithRetry();

	startApiServer();
}

process.on("SIGINT", async () => {
	log.info("Shutting down...");
	stopPolling();
	await closePool();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	log.info("Shutting down...");
	stopPolling();
	await closePool();
	process.exit(0);
});

main().catch((err) => {
	log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});

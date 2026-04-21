import { closePool } from "./db/client.ts";
import { startApiServer, stopPolling } from "./api/server.ts";
import { connectWithRetry } from "./bootstrap.ts";
import { initBeekeeperSigner, closeBeekeeperSigner } from "./api/services/beekeeper-signer.ts";
import { startMultisigHealthMonitor, stopMultisigHealthMonitor } from "./api/services/multisig-health.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";
import { PROTOCOL_VERSION, PROTOCOL_GENESIS_BLOCK } from "./protocol/index.ts";

const log = createLogger("api");

async function main(): Promise<void> {
	log.info(`NFTLox API Server starting — protocol v${PROTOCOL_VERSION}, genesis #${PROTOCOL_GENESIS_BLOCK}`);

	await connectWithRetry();

	// Read keys from env, init beekeeper, then wipe from process.env.
	// Keys are never stored in config to avoid lingering in V8 heap as frozen strings.
	// API roles need ACTIVE_KEY for node multisig and POSTING_KEY for sale_lock.
	// When both are present we import both into beekeeper.
	const activeKey = process.env.ACTIVE_KEY ?? "";
	const postingKey = process.env.POSTING_KEY ?? "";
	const bkPassword = process.env.BEEKEEPER_PASSWORD ?? "";
	if (activeKey) {
		await initBeekeeperSigner(activeKey, bkPassword, postingKey || null);
		delete process.env.ACTIVE_KEY;
		delete process.env.POSTING_KEY;
		delete process.env.BEEKEEPER_PASSWORD;
	}

	await startMultisigHealthMonitor();
	startApiServer();
}

async function shutdown(): Promise<void> {
	log.info("Shutting down...");
	stopPolling();
	stopMultisigHealthMonitor();
	await closeBeekeeperSigner();
	await closePool();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
	log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});

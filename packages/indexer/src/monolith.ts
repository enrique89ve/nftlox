import { closePool } from "./db/client.ts";
import { startApiServer } from "./api/server.ts";
import { setStartupTime, setSynced, updateSyncProgress } from "./scanner/sync-state.ts";
import { connectWithRetry } from "./bootstrap.ts";
import { initBeekeeperSigner, closeBeekeeperSigner } from "./api/services/beekeeper-signer.ts";
import { startMultisigHealthMonitor, stopMultisigHealthMonitor } from "./api/services/multisig-health.ts";
import { startPricePoller, stopPricePoller } from "./utils/fee-oracle.ts";
import { startHeartbeatDaemon, stopHeartbeatDaemon } from "./services/heartbeat-daemon.ts";
import { createLogger } from "./utils/logger.ts";
import { config } from "./config.ts";
import { dns } from "bun";
import type { WorkerMessage, MainToWorkerMessage } from "./scanner/sync-messages.ts";
import { buildInternalHealthResponse } from "./health/internal-health.ts";
import { PROTOCOL_VERSION, PROTOCOL_GENESIS_BLOCK } from "./protocol/index.ts";

const log = createLogger("monolith");

// Catch unhandled errors to prevent silent process death
process.on("unhandledRejection", (err) => {
	log.error("Unhandled rejection", { error: err instanceof Error ? err.message : String(err) });
});

process.on("uncaughtException", (err) => {
	log.error("Uncaught exception — shutting down", { error: err.message });
	process.exit(1);
});

let syncWorker: Worker | null = null;
let syncWorkerRestarts = 0;
let shuttingDown = false;

const MAX_WORKER_RESTARTS = 10;
const WORKER_RESTART_WINDOW_MS = 60_000;
let lastRestartWindowStart = 0;

function scheduleSyncWorkerRestart(): void {
	if (shuttingDown) return;

	const now = Date.now();
	if (now - lastRestartWindowStart > WORKER_RESTART_WINDOW_MS) {
		syncWorkerRestarts = 0;
		lastRestartWindowStart = now;
	}

	syncWorkerRestarts++;
	if (syncWorkerRestarts > MAX_WORKER_RESTARTS) {
		log.error(`Sync worker crashed ${MAX_WORKER_RESTARTS} times in ${WORKER_RESTART_WINDOW_MS / 1000}s — giving up. Manual intervention required.`);
		return;
	}

	const delayMs = Math.min(30_000, 1000 * 2 ** (syncWorkerRestarts - 1));
	log.warn(`Restarting sync worker in ${delayMs}ms (attempt ${syncWorkerRestarts}/${MAX_WORKER_RESTARTS})`);
	setTimeout(() => {
		if (!shuttingDown) startSyncWorker();
	}, delayMs);
}

function startSyncWorker(): void {
	const worker = new Worker(new URL("./scanner/sync-worker.ts", import.meta.url).href);

	worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
		const msg = event.data;

		switch (msg.type) {
			case "progress":
				updateSyncProgress(msg.progress);
				break;
			case "synced":
				setSynced(msg.synced);
				break;
			case "ready":
				log.info("Sync worker ready — processing blocks");
				syncWorkerRestarts = 0;
				break;
			case "log":
				log[msg.level](msg.message, msg.data);
				break;
			case "fatal":
				log.error("Sync worker fatal error", { error: msg.error });
				break;
		}
	};

	worker.onerror = (event) => {
		log.error("Sync worker error", { message: event.message });
	};

	worker.addEventListener("close", (event) => {
		const exitCode = (event as CloseEvent).code;
		log.warn("Sync worker closed", { exitCode });
		syncWorker = null;
		if (exitCode !== 0) {
			scheduleSyncWorkerRestart();
		}
	});

	syncWorker = worker;
}

function stopSyncWorker(): void {
	shuttingDown = true;
	if (!syncWorker) return;
	const msg: MainToWorkerMessage = { type: "stop" };
	syncWorker.postMessage(msg);
}

async function main(): Promise<void> {
	setStartupTime();
	log.info(`NFTLox Indexer starting (monolith + worker) — protocol v${PROTOCOL_VERSION}, genesis #${PROTOCOL_GENESIS_BLOCK}`);

	// Main thread connects to DB for API queries
	await connectWithRetry();

	// Read keys from env, init beekeeper, then wipe from JS memory.
	// POSTING_KEY is only imported when NODE_REGISTER=true (config enforces presence).
	const activeKey = process.env.ACTIVE_KEY ?? "";
	const postingKey = config.nodeRegister ? (process.env.POSTING_KEY ?? "") : "";
	const bkPassword = process.env.BEEKEEPER_PASSWORD ?? "";
	if (activeKey) {
		await initBeekeeperSigner(activeKey, bkPassword, postingKey || null);
		delete process.env.ACTIVE_KEY;
		delete process.env.POSTING_KEY;
		delete process.env.BEEKEEPER_PASSWORD;
	}

	await startMultisigHealthMonitor();
	startPricePoller();
	// API server runs on main thread — event loop stays free
	startApiServer();

	if (config.healthPort > 0) {
		Bun.serve({
			port: config.healthPort,
			fetch(request) {
				return buildInternalHealthResponse(request);
			},
		});
		log.info(`Internal health endpoints on port ${config.healthPort}`);
	}

	// Pre-resolve DNS for Hive endpoints to avoid cold-start latency
	for (const endpoint of config.hiveEndpoints) {
		try {
			const url = new URL(endpoint);
			dns.prefetch(url.hostname, Number(url.port) || 443);
		} catch { /* invalid URL handled elsewhere */ }
	}

	// Sync engine runs on dedicated worker thread
	startSyncWorker();

	// Public-directory heartbeat emitter. No-ops when NODE_REGISTER=false or
	// the operator hasn't yet emitted `node_register` — see the daemon for the
	// exact preconditions.
	await startHeartbeatDaemon();
}

async function shutdown(): Promise<void> {
	log.info("Shutting down...");
	stopHeartbeatDaemon();
	stopSyncWorker();
	stopMultisigHealthMonitor();
	stopPricePoller();
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

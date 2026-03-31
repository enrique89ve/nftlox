import { config } from "@/config.ts";
import { withTransaction } from "@/db/client.ts";
import { getLastBlock, updateLastBlock, cleanupExpiredOperations } from "@/db/queries/sync.ts";
import { getBlockchainHead, getCustomJsonInRange, getHafAHBlockRange, getTransfersInTransaction } from "./hive-client.ts";
import { ACTION_BUY, ACTION_PACK_BUY } from "nftlox-sdk";
import { parseHafAHOperations } from "./operation-parser.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { setSynced, updateSyncProgress } from "./sync-state.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync");

const MASSIVE_THRESHOLD = 100;
const SYNC_TOLERANCE = 10;
const MAX_CONTINUITY_FAILURES = 3;

let running = false;

/** @internal — exposed for unit tests only */
export function setRunning(value: boolean): void {
	running = value;
}

export function startSync(): void {
	running = true;
	log.info("Sync engine started", {
		genesisBlock: config.genesisBlock,
		syncInterval: config.syncIntervalMs,
		method: "HafAH",
	});

	syncLoop().catch((err) => {
		log.error("Sync loop fatal error", {
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

export function stopSync(): void {
	running = false;
	log.info("Sync engine stopping");
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let lastCleanup = 0;

async function syncLoop(): Promise<void> {
	while (running) {
		try {
			await syncCycle();

			if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
				lastCleanup = Date.now();
				const deleted = await cleanupExpiredOperations();
				if (deleted > 0) {
					log.info(`Cleanup: removed ${deleted} expired invalid/orphaned operations`);
				}
			}
		} catch (err) {
			log.error("Sync cycle error", {
				error: err instanceof Error ? err.message : String(err),
			});
			await sleep(config.syncIntervalMs * 2);
		}
	}
}

export async function syncCycle(): Promise<void> {
	let lastBlock = await getLastBlock();
	if (lastBlock === 0) {
		lastBlock = config.genesisBlock - 1;
		await updateLastBlock(lastBlock);
		log.info("Initialized from genesis block", { genesisBlock: config.genesisBlock });
	}

	const chain = await getBlockchainHead();

	// Process only up to the last irreversible block to prevent reorg-induced state divergence.
	// This adds ~45s delay (Hive finality = ~15 blocks × 3s) but guarantees all processed
	// operations are final and cannot be reverted by a chain reorganization.
	const headBlock = chain.irreversibleBlock;
	const behind = headBlock - lastBlock;

	updateSyncProgress(lastBlock, chain.headBlock);

	if (behind <= SYNC_TOLERANCE) {
		setSynced(true);
		if (behind <= 0) {
			await sleep(config.syncIntervalMs);
			return;
		}
	}

	const isMassive = behind > MASSIVE_THRESHOLD;
	const blockRange = getHafAHBlockRange();

	if (isMassive) {
		setSynced(false);
		log.info("MASSIVE SYNC started (HafAH)", {
			lastBlock,
			headBlock,
			behind,
			blockRange,
		});
	}

	let current = lastBlock + 1;
	let totalOps = 0;
	let totalBlocks = 0;
	let continuityFailures = 0;
	const startTime = Date.now();

	while (current <= headBlock && running) {
		const rangeEnd = Math.min(current + blockRange - 1, headBlock);

		// --- Block continuity assertion ---
		// Verify the DB cursor matches our in-memory cursor before each batch.
		// Catches any divergence between memory and persisted state.
		const dbLastBlock = await getLastBlock();
		const expectedStart = dbLastBlock + 1;
		if (current !== expectedStart) {
			continuityFailures++;
			log.error("BLOCK CONTINUITY VIOLATION — resetting cursor from DB", {
				expected: expectedStart,
				actual: current,
				dbLastBlock,
				attempt: continuityFailures,
			});
			if (continuityFailures >= MAX_CONTINUITY_FAILURES) {
				throw new Error(`Block continuity failed ${continuityFailures} times — aborting cycle`);
			}
			current = expectedStart;
			continue;
		}
		continuityFailures = 0;

		// Fetch custom_json ops in this range via HafAH (pre-filtered by protocol ID)
		const hafOps = await getCustomJsonInRange(current, rangeEnd, config.protocolId, behind);

		// Parse validated protocol operations
		const ops = parseHafAHOperations(hafOps);

		// Enrich buy and pack_buy ops with paired transfers for payment verification
		const buyOps = ops.filter(op =>
			op.action === ACTION_BUY || op.action === ACTION_PACK_BUY
		);
		await Promise.all(
			buyOps.map(async (op) => {
				op.pairedTransfers = await getTransfersInTransaction(op.txId);
			})
		);

		// Process operations in a transaction.
		// routeOperation is infallible — individual handler errors are caught and recorded
		// as invalid_operations, so a single bad op never aborts the batch.
		if (ops.length > 0) {
			await withTransaction(async (txn) => {
				if (isMassive) {
					await txn`SET LOCAL synchronous_commit = OFF`;
				}
				for (const op of ops) {
					await routeOperation(op, txn);
				}
				await updateLastBlock(rangeEnd, txn);
			});
		} else {
			// No ops in range — just advance the cursor
			await updateLastBlock(rangeEnd);
		}

		// Yield to event loop during massive sync so the API server can handle requests
		if (isMassive) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		const blocksInRange = rangeEnd - current + 1;
		totalOps += ops.length;
		totalBlocks += blocksInRange;

		updateSyncProgress(rangeEnd, headBlock);

		if (ops.length > 0) {
			log.info("Processed ops", {
				range: `${current}-${rangeEnd}`,
				customJson: hafOps.length,
				protocolOps: ops.length,
			});
		}

		// Progress log every ~10k blocks
		if (isMassive && totalBlocks % 10000 < blockRange) {
			const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.001);
			const pct = ((rangeEnd - lastBlock) / behind * 100).toFixed(2);
			const bps = Math.round(totalBlocks / elapsedSec);
			const remaining = headBlock - rangeEnd;
			const eta = bps > 0 ? Math.ceil(remaining / bps / 60) : 0;
			log.info("Progress", {
				block: rangeEnd,
				scanned: totalBlocks,
				protocolOps: totalOps,
				pct: `${pct}%`,
				elapsed: `${elapsedSec.toFixed(1)}s`,
				blocksPerSec: bps,
				etaMinutes: eta,
			});
		}

		current = rangeEnd + 1;
	}

	if (isMassive && totalBlocks > 0) {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		log.info("MASSIVE SYNC complete", {
			blocks: totalBlocks,
			protocolOps: totalOps,
			elapsed: `${elapsed}s`,
		});
		setSynced(true);
		log.info("Indexer is now IN SYNC — API accepting requests");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

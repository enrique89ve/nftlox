import { config } from "@/config.ts";
import { withTransaction } from "@/db/client.ts";
import { getLastBlock, updateLastBlock } from "@/db/queries/sync.ts";
import { getHeadBlockNum, getCustomJsonInRange, getHafAHBlockRange, getTransfersInTransaction } from "./hive-client.ts";
import { ACTION_BUY, ACTION_PACK_BUY } from "nftlox-sdk";
import { parseHafAHOperations } from "./operation-parser.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { setSynced, updateSyncProgress } from "./sync-state.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync");

const MASSIVE_THRESHOLD = 100;
const SYNC_TOLERANCE = 10;

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

async function syncLoop(): Promise<void> {
	while (running) {
		try {
			await syncCycle();
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

	const headBlock = await getHeadBlockNum();
	const behind = headBlock - lastBlock;

	updateSyncProgress(lastBlock, headBlock);

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
	const startTime = Date.now();

	while (current <= headBlock && running) {
		const rangeEnd = Math.min(current + blockRange - 1, headBlock);

		// Fetch custom_json ops in this range via HafAH (pre-filtered by protocol ID)
		const hafOps = await getCustomJsonInRange(current, rangeEnd, config.protocolId, behind);

		// Parse validated protocol operations
		const ops = parseHafAHOperations(hafOps);

		// Enrich buy and pack_buy ops with paired transfers for payment verification
		const buyOps = ops.filter(op =>
			op.action === ACTION_BUY || op.action === ACTION_PACK_BUY
		);
		for (const op of buyOps) {
			op.pairedTransfers = await getTransfersInTransaction(op.txId);
		}

		// Process operations in a transaction
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
			const pct = ((rangeEnd - lastBlock) / behind * 100).toFixed(2);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			const bps = (totalBlocks / ((Date.now() - startTime) / 1000)).toFixed(0);
			const remaining = headBlock - rangeEnd;
			const eta = Number(bps) > 0
				? Math.ceil(remaining / Number(bps) / 60)
				: 0;
			log.info("Progress", {
				block: rangeEnd,
				scanned: totalBlocks,
				protocolOps: totalOps,
				pct: `${pct}%`,
				elapsed: `${elapsed}s`,
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

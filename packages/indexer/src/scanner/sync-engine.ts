import { config } from "@/config.ts";
import { withTransaction } from "@/db/client.ts";
import { getLastBlock, updateLastBlock } from "@/db/queries/sync.ts";
import { getHeadBlockNum, getBlockRange } from "./hive-client.ts";
import { parseBlockOperations } from "./operation-parser.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { setSynced, updateSyncProgress } from "./sync-state.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync");

const MASSIVE_BATCH_SIZE = 1000;
const MASSIVE_THRESHOLD = 100;
const LIVE_BATCH_SIZE = 100;

let running = false;

export function startSync(): void {
	running = true;
	log.info("Sync engine started", {
		genesisBlock: config.genesisBlock,
		syncInterval: config.syncIntervalMs,
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

async function syncCycle(): Promise<void> {
	let lastBlock = await getLastBlock();
	if (lastBlock === 0) {
		lastBlock = config.genesisBlock - 1;
		await updateLastBlock(lastBlock);
		log.info("Initialized from genesis block", { genesisBlock: config.genesisBlock });
	}

	const headBlock = await getHeadBlockNum();
	const behind = headBlock - lastBlock;

	updateSyncProgress(lastBlock, headBlock);

	if (behind <= 0) {
		setSynced(true);
		await sleep(config.syncIntervalMs);
		return;
	}

	const isMassive = behind > MASSIVE_THRESHOLD;
	const batchSize = isMassive ? MASSIVE_BATCH_SIZE : LIVE_BATCH_SIZE;

	if (isMassive) {
		setSynced(false);
		log.info("MASSIVE SYNC started", {
			lastBlock,
			headBlock,
			behind,
			batchSize,
			estimatedMinutes: Math.ceil(behind / 300 / 60),
		});
	}

	let current = lastBlock + 1;
	let totalOps = 0;
	let totalBlocks = 0;
	const startTime = Date.now();

	while (current <= headBlock && running) {
		const count = Math.min(batchSize, headBlock - current + 1);
		const blocks = await getBlockRange(current, count);

		if (blocks.length === 0) break;

		let opsProcessed = 0;
		const batchEnd = current + blocks.length - 1;

		await withTransaction(async (txn) => {
			for (const block of blocks) {
				const ops = parseBlockOperations(block);
				for (const op of ops) {
					await routeOperation(op, txn);
					opsProcessed++;
				}
			}
			await updateLastBlock(batchEnd, txn);
		});

		totalOps += opsProcessed;
		totalBlocks += blocks.length;

		updateSyncProgress(batchEnd, headBlock);

		if (opsProcessed > 0) {
			log.info("Processed ops", {
				range: `${current}-${batchEnd}`,
				ops: opsProcessed,
			});
		}

		const logInterval = isMassive ? 5000 : 500;
		if (totalBlocks % logInterval < batchSize) {
			const pct = ((batchEnd - lastBlock) / behind * 100).toFixed(2);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			const bps = (totalBlocks / ((Date.now() - startTime) / 1000)).toFixed(0);
			const eta = behind > 0
				? Math.ceil((headBlock - batchEnd) / Number(bps) / 60)
				: 0;
			log.info("Progress", {
				block: batchEnd,
				scanned: totalBlocks,
				ops: totalOps,
				pct: `${pct}%`,
				elapsed: `${elapsed}s`,
				blocksPerSec: bps,
				etaMinutes: eta,
			});
		}

		current = batchEnd + 1;
	}

	if (isMassive && totalBlocks > 0) {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		log.info("MASSIVE SYNC complete", {
			blocks: totalBlocks,
			ops: totalOps,
			elapsed: `${elapsed}s`,
		});
		setSynced(true);
		log.info("Indexer is now IN SYNC — API accepting requests");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

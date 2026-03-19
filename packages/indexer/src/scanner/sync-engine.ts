import { config } from "../config.ts";
import { withTransaction } from "../db/client.ts";
import { getLastBlock, updateLastBlock } from "../db/queries/sync.ts";
import { getHeadBlockNum, getBlockRange } from "./hive-client.ts";
import { parseBlockOperations } from "./operation-parser.ts";
import { routeOperation } from "../processor/action-router.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("sync");

let running = false;

export async function startSync(): Promise<void> {
	running = true;
	log.info("Sync engine started", {
		genesisBlock: config.genesisBlock,
		batchSize: config.batchSize,
		syncInterval: config.syncIntervalMs,
	});

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

export function stopSync(): void {
	running = false;
	log.info("Sync engine stopping");
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

	if (behind <= 0) {
		log.debug("Caught up", { lastBlock, headBlock });
		await sleep(config.syncIntervalMs);
		return;
	}

	log.info("Syncing", { lastBlock, headBlock, behind });

	let current = lastBlock + 1;
	let totalOps = 0;
	let totalBlocks = 0;

	while (current <= headBlock && running) {
		const count = Math.min(config.batchSize, headBlock - current + 1);
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

		if (opsProcessed > 0) {
			log.info(`Processed ops`, {
				range: `${current}-${batchEnd}`,
				ops: opsProcessed,
			});
		}

		// Progress log every 500 blocks
		if (totalBlocks % 500 < config.batchSize) {
			const pct = ((batchEnd - lastBlock) / behind * 100).toFixed(2);
			log.info(`Progress`, {
				block: batchEnd,
				scanned: totalBlocks,
				ops: totalOps,
				pct: `${pct}%`,
			});
		}

		current = batchEnd + 1;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

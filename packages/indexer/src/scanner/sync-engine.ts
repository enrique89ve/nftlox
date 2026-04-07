import { config } from "@/config.ts";
import { withTransaction } from "@/db/client.ts";
import {
  getLastBlock,
  updateLastBlock,
  cleanupExpiredOperations,
  insertInvalidOperation,
} from "@/db/queries/sync.ts";
import {
  acquireSyncLock,
  releaseSyncLock,
  verifyLockHeld,
} from "./sync-lock.ts";
import {
  getBlockchainHead,
  getCustomJsonInRange,
  getHafAHBlockRange,
  getTransfersInTransaction,
  checkClockDrift,
} from "./hive-client.ts";
import { ACTION_BUY, ACTION_PACK_BUY } from "@/protocol/index.ts";
import {
  parseHafAHOperations,
  type RejectedOperation,
  type ParsedOperation,
} from "./operation-parser.ts";
import { routeOperation } from "@/processor/action-router.ts";
import { setSynced, updateSyncProgress } from "./sync-state.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync");

const MASSIVE_THRESHOLD = 100;
// How many blocks behind before the API is considered out-of-sync and blocks requests.
// Hive produces 1 block every 3s; a small lag is structurally unavoidable (network
// round-trip + sync interval). 10 blocks = ~30s of data lag, still useful for reads.
// Exported so /api/health and /api/status report the same threshold.
export const SYNC_TOLERANCE_BLOCKS = 5;
const MAX_CONTINUITY_FAILURES = 3;
const MAX_CONSECUTIVE_HANDLER_FAILURES = 10;

// ============ BATCH FETCH ============

interface FetchedBatch {
  readonly from: number;
  readonly to: number;
  readonly ops: ParsedOperation[];
  readonly rejected: RejectedOperation[];
  readonly rawCount: number;
}

/**
 * Fetch, parse, and enrich a single block range.
 * Read-only I/O + in-memory enrichment — no DB writes, safe to run in parallel.
 */
async function fetchBatch(
  from: number,
  to: number,
  protocolId: string,
  behind: number,
): Promise<FetchedBatch> {
  const hafOps = await getCustomJsonInRange(from, to, protocolId, behind);
  const { ops, rejected } = parseHafAHOperations(hafOps);

  // Enrich buy/pack_buy ops with paired transfers
  const buyOps = ops.filter(
    (op) => op.action === ACTION_BUY || op.action === ACTION_PACK_BUY,
  );
  const transferPools = new Map<
    string,
    {
      transfers: Array<{
        from: string;
        to: string;
        amount: number;
        currency: string;
        memo: string;
      }>;
      consumed: Set<number>;
    }
  >();
  await Promise.all(
    [...new Set(buyOps.map((op) => op.txId))].map(async (txId) => {
      const transfers = await getTransfersInTransaction(txId);
      transferPools.set(txId, { transfers, consumed: new Set() });
    }),
  );
  for (const op of buyOps) {
    const pool = transferPools.get(op.txId);
    if (!pool) throw new Error(`Transfer pool missing for txId ${op.txId}`);
    op.pairedTransfers = pool.transfers;
    op.transferPool = pool;
  }

  return { from, to, ops, rejected, rawCount: hafOps.length };
}

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

  checkClockDrift().catch(() => {});

  syncLoop().catch((err) => {
    log.error("Sync loop fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function stopSync(): Promise<void> {
  running = false;
  await releaseSyncLock();
  log.info("Sync engine stopping");
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLOCK_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LOCK_RETRY_INTERVAL_MS = 10_000;
const LOCK_VERIFY_INTERVAL_MS = 30_000;

let lastCleanup = 0;
let lastClockCheck = 0;
let lastLockVerify = 0;

/**
 * Blocks until the advisory lock is acquired or `running` becomes false.
 * Retries every LOCK_RETRY_INTERVAL_MS if another instance holds the lock.
 */
async function waitForLock(): Promise<boolean> {
  while (running) {
    const acquired = await acquireSyncLock();
    if (acquired) return true;
    log.warn("Another instance holds the sync lock — retrying", {
      retryMs: LOCK_RETRY_INTERVAL_MS,
    });
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
  return false;
}

async function syncLoop(): Promise<void> {
  if (!(await waitForLock())) return;

  while (running) {
    try {
      // Verify the dedicated lock connection is still alive.
      // If the connection dropped, the advisory lock was auto-released by PG.
      // We must re-acquire before processing any blocks.
      if (Date.now() - lastLockVerify > LOCK_VERIFY_INTERVAL_MS) {
        lastLockVerify = Date.now();
        const held = await verifyLockHeld();
        if (!held) {
          log.error("Advisory lock lost — connection dropped. Re-acquiring...");
          if (!(await waitForLock())) return;
          lastLockVerify = Date.now();
        }
      }

      await syncCycle();

      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        lastCleanup = Date.now();
        const deleted = await cleanupExpiredOperations();
        if (deleted > 0) {
          log.info(
            `Cleanup: removed ${deleted} expired invalid/orphaned operations`,
          );
        }
      }
      if (Date.now() - lastClockCheck > CLOCK_CHECK_INTERVAL_MS) {
        lastClockCheck = Date.now();
        await checkClockDrift().catch(() => {});
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
    log.info("Initialized from genesis block", {
      genesisBlock: config.genesisBlock,
    });
  }

  let chain = await getBlockchainHead("fast");
  if (chain.irreversibleBlock - lastBlock <= MASSIVE_THRESHOLD) {
    chain = await getBlockchainHead();
  }

  // Process only up to the last irreversible block to prevent reorg-induced state divergence.
  // This adds ~45s delay (Hive finality = ~15 blocks × 3s) but guarantees all processed
  // operations are final and cannot be reverted by a chain reorganization.
  const irreversibleBlock = chain.irreversibleBlock;
  const headBlock = chain.headBlock;
  const behind = irreversibleBlock - lastBlock;

  updateSyncProgress({ lastBlock, headBlock, irreversibleBlock });

  // API readiness: mark as synced when within tolerance (small natural lag).
  // This separates "is the data useful?" from "are there blocks to fetch?".
  // A 10-block lag (~30s) is still valid data for an NFT marketplace.
  setSynced(behind <= SYNC_TOLERANCE_BLOCKS);

  if (behind <= 0) {
    await sleep(config.syncIntervalMs);
    return;
  }

  const isMassive = behind > MASSIVE_THRESHOLD;
  const blockRange = getHafAHBlockRange();

  if (isMassive) {
    log.info("MASSIVE SYNC started (HafAH)", {
      lastBlock,
      headBlock,
      irreversibleBlock,
      behind,
      blockRange,
    });
  }

  let current = lastBlock + 1;
  let totalOps = 0;
  let totalBlocks = 0;
  let continuityFailures = 0;
  const startTime = Date.now();

  while (current <= irreversibleBlock && running) {
    const range1End = Math.min(current + blockRange - 1, irreversibleBlock);

    // --- Block continuity assertion ---
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
        throw new Error(
          `Block continuity failed ${continuityFailures} times — aborting cycle`,
        );
      }
      current = expectedStart;
      continue;
    }
    continuityFailures = 0;

    // During massive sync, fetch 2 ranges in parallel to halve HTTP latency.
    // Range 2 is optional — if it fails we still process range 1.
    const batches: FetchedBatch[] = [];
    const hasRange2 = isMassive && range1End < irreversibleBlock;
    const range2Start = range1End + 1;
    const range2End = hasRange2
      ? Math.min(range2Start + blockRange - 1, irreversibleBlock)
      : 0;

    if (hasRange2) {
      const results = await Promise.allSettled([
        fetchBatch(current, range1End, config.protocolId, behind),
        fetchBatch(range2Start, range2End, config.protocolId, behind),
      ]);

      // Range 1 must succeed — it's the current cursor position
      if (results[0].status === "rejected") {
        const reason = results[0].reason;
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      batches.push(results[0].value);

      // Range 2 is best-effort — skip if it fails, we'll retry next iteration
      if (results[1].status === "fulfilled") {
        batches.push(results[1].value);
      } else {
        log.warn(
          "Parallel fetch for range 2 failed, continuing with range 1 only",
          {
            range2: `${range2Start}-${range2End}`,
            error:
              results[1].reason instanceof Error
                ? results[1].reason.message
                : String(results[1].reason),
          },
        );
      }
    } else {
      batches.push(
        await fetchBatch(current, range1End, config.protocolId, behind),
      );
    }

    // Process all batches in strict block order within a single transaction.
    const lastBatch = batches[batches.length - 1] ?? batches[0];
    if (!lastBatch) throw new Error("No batches produced — logic error");
    const hasOps = batches.some(
      (b) => b.ops.length > 0 || b.rejected.length > 0,
    );

    if (hasOps) {
      await withTransaction(async (txn) => {
        if (isMassive) {
          await txn`SET LOCAL synchronous_commit = OFF`;
        }

        let consecutiveFailures = 0;
        for (const batch of batches) {
          for (const rej of batch.rejected) {
            await insertInvalidOperation(
              {
                blockNum: rej.blockNum,
                txId: rej.txId,
                operationId: rej.operationId,
                signer: rej.signer,
                action: null,
                reason: rej.reason,
                rawPayload: rej.rawPayload,
              },
              txn,
            );
          }
          for (const op of batch.ops) {
            const success = await routeOperation(op, txn);
            if (success) {
              consecutiveFailures = 0;
            } else {
              consecutiveFailures++;
              if (consecutiveFailures >= MAX_CONSECUTIVE_HANDLER_FAILURES) {
                throw new Error(
                  `Circuit breaker: ${consecutiveFailures} consecutive handler failures in block range ${batch.from}-${batch.to}`,
                );
              }
            }
          }
        }

        await updateLastBlock(lastBatch.to, txn);
      });
    } else {
      await updateLastBlock(lastBatch.to);
    }

    // Yield between batches during massive sync so Postgres can serve API queries.
    if (isMassive) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const blocksProcessed = lastBatch.to - current + 1;
    const opsProcessed = batches.reduce((sum, b) => sum + b.ops.length, 0);
    totalOps += opsProcessed;
    totalBlocks += blocksProcessed;

    updateSyncProgress({
      lastBlock: lastBatch.to,
      headBlock,
      irreversibleBlock,
    });

    if (opsProcessed > 0 || batches.some((b) => b.rejected.length > 0)) {
      for (const batch of batches) {
        if (batch.ops.length > 0 || batch.rejected.length > 0) {
          log.info("Processed ops", {
            range: `${batch.from}-${batch.to}`,
            customJson: batch.rawCount,
            protocolOps: batch.ops.length,
            ...(batch.rejected.length > 0
              ? { rejectedOps: batch.rejected.length }
              : {}),
          });
        }
      }
    }

    // Progress log every ~10k blocks
    if (isMassive && totalBlocks % 10000 < blockRange * batches.length) {
      const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.001);
      const pct = (((lastBatch.to - lastBlock) / behind) * 100).toFixed(2);
      const bps = Math.round(totalBlocks / elapsedSec);
      const remaining = irreversibleBlock - lastBatch.to;
      const eta = bps > 0 ? Math.ceil(remaining / bps / 60) : 0;
      log.info("Progress", {
        block: lastBatch.to,
        scanned: totalBlocks,
        protocolOps: totalOps,
        pct: `${pct}%`,
        elapsed: `${elapsedSec.toFixed(1)}s`,
        blocksPerSec: bps,
        etaMinutes: eta,
        parallel: batches.length > 1,
      });
    }

    current = lastBatch.to + 1;
  }

  if (totalBlocks > 0 && current > irreversibleBlock) {
    if (isMassive) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log.info("MASSIVE SYNC complete", {
        blocks: totalBlocks,
        protocolOps: totalOps,
        elapsed: `${elapsed}s`,
      });
    }

    setSynced(true);
    if (isMassive) {
      log.info("Indexer is now IN SYNC — API accepting requests");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

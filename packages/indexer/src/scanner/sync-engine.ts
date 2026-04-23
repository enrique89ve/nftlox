import { config } from "@/config.ts";
import { withTransaction } from "@/db/client.ts";
import {
  getLastBlock,
  updateLastBlock,
  updateHiveHeadBlock,
  cleanupExpiredOperations,
  insertInvalidOperation,
} from "@/db/queries/sync.ts";
import { sweepExpiredBuyCommitments } from "@/db/queries/nft-mutations.ts";
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
import {
  ACTION_BUY,
  ACTION_CREATE_COLLECTION,
} from "@/protocol/index.ts";
import {
  parseHafAHOperations,
  type RejectedOperation,
  type ParsedOperation,
} from "./operation-parser.ts";
import { routeOperationDetailed } from "@/processor/action-router.ts";
import { markSyncActivity, setSynced, updateSyncProgress } from "./sync-state.ts";
import { ChainAnchorMismatchError, verifyChainAnchors } from "./chain-anchors.ts";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("sync");

const MASSIVE_THRESHOLD = 100;
// How many blocks behind before the API is considered out-of-sync and blocks requests.
// Hive produces 1 block every 3s; a small lag is structurally unavoidable (network
// round-trip + sync interval). 10 blocks = ~30s of data lag, still useful for reads.
// Exported so /api/health and /api/status report the same threshold.
export const SYNC_TOLERANCE_BLOCKS = 5;
const MAX_CONTINUITY_FAILURES = 3;
const MAX_CONSECUTIVE_FATAL_ROUTE_FAILURES = 10;

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

  // Enrich operations whose validation depends on transfers from the same Hive tx.
  // node_register is intentionally absent: it is fee-less, so the same-tx
  // transfer lookup would be dead I/O.
  const transferBackedOps = ops.filter(
    (op) => op.action === ACTION_BUY || op.action === ACTION_CREATE_COLLECTION,
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
    [...new Set(transferBackedOps.map((op) => op.txId))].map(async (txId) => {
      const transfers = await getTransfersInTransaction(txId);
      transferPools.set(txId, { transfers, consumed: new Set() });
    }),
  );
  for (const op of transferBackedOps) {
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

/** @internal — exposed for unit tests only. Resets module-level head-tracking state. */
export function resetHeadTracker(): void {
  lastKnownIrreversibleBlock = 0;
}

export function startSync(): void {
  running = true;
  log.info("Sync engine started", {
    genesisBlock: config.genesisBlock,
    syncInterval: config.syncIntervalMs,
    method: "HafAH",
  });

  checkClockDrift().catch(() => {});

  // Chain-anchor verification is a hard gate before any writes: genesis block_id
  // must agree with the live chain on ≥2 endpoints. If it doesn't, we exit so
  // the orchestrator (systemd/Docker/k8s) can surface the failure instead of
  // silently running against a divergent chain.
  verifyChainAnchors()
    .then(() => syncLoop())
    .catch((err) => {
      log.error("Sync loop fatal error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof ChainAnchorMismatchError) {
        process.exit(1);
      }
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

// Sentinel thrown by syncCycle when verifyLockHeld() fails before a write.
// syncLoop catches this specifically and re-acquires the lock before retrying.
// A plain string match is used to avoid an extra custom-error class.
const LOCK_LOST_MARKER = "SYNC_LOCK_LOST";

let lastCleanup = 0;
let lastClockCheck = 0;
// Monotonic invariant: Hive's last_irreversible_block_num only moves forward.
// Any endpoint response that reports a lower value than previously observed is
// either lagging (stale node) or lying (compromised). Tracked across cycles so
// a single endpoint that lies in one cycle cannot rewrite our frontier.
let lastKnownIrreversibleBlock = 0;

/**
 * Blocks until the advisory lock is acquired or `running` becomes false.
 * Retries every LOCK_RETRY_INTERVAL_MS if another instance holds the lock.
 */
async function waitForLock(): Promise<boolean> {
  while (running) {
    const result = await acquireSyncLock();
    if (result.status === "acquired") return true;
    if (result.status === "busy") {
      log.warn("Another instance holds the sync lock — retrying", {
        retryMs: LOCK_RETRY_INTERVAL_MS,
      });
    } else {
      log.warn("Sync lock unavailable — PostgreSQL connection retry scheduled", {
        error: result.error,
        retryMs: LOCK_RETRY_INTERVAL_MS,
      });
    }
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
  return false;
}

async function syncLoop(): Promise<void> {
  if (!(await waitForLock())) return;

  while (running) {
    try {
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
      const message = err instanceof Error ? err.message : String(err);
      // LOCK_LOST_MARKER: syncCycle aborted because the advisory lock dropped
      // mid-batch. Re-acquire before the next cycle — do not sleep the normal
      // backoff. Without this, another indexer could race in and write to the
      // same cursor while we wait.
      if (message.includes(LOCK_LOST_MARKER)) {
        log.error("Advisory lock lost mid-cycle — re-acquiring");
        if (!(await waitForLock())) return;
        continue;
      }
      log.error("Sync cycle error", { error: message });
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

  // Always fetch head via multi-endpoint consensus — NEVER trust a single endpoint
  // for the irreversible frontier. During massive sync the previous code trusted the
  // "fast" single-endpoint path to avoid the extra RPCs; that lets one lying or stale
  // node dictate how far we advance. The consensus cost is ~one RPC per endpoint per
  // `syncIntervalMs` (default 3s) — trivial compared to the thousands of ops/block
  // that depend on the irreversible frontier being correct.
  const chain = await getBlockchainHead();

  // Hive invariant: irreversibleBlock is monotonic forward. A response that regresses
  // is either a stale node leaking through consensus or an attack — refuse to use it.
  // Small backward jitter is tolerated (multiple endpoints, minor propagation delay),
  // but anything beyond a few blocks is a red flag. Abort the cycle; next cycle retries.
  const IRREVERSIBLE_REGRESSION_TOLERANCE = 3;
  if (lastKnownIrreversibleBlock > 0
    && chain.irreversibleBlock < lastKnownIrreversibleBlock - IRREVERSIBLE_REGRESSION_TOLERANCE) {
    throw new Error(
      `Irreversible block regressed: ${chain.irreversibleBlock} < ${lastKnownIrreversibleBlock} ` +
      `(tolerance ${IRREVERSIBLE_REGRESSION_TOLERANCE}). Suspect stale or compromised endpoint. ` +
      `Aborting cycle; will retry.`,
    );
  }
  if (chain.irreversibleBlock > lastKnownIrreversibleBlock) {
    lastKnownIrreversibleBlock = chain.irreversibleBlock;
  }

  // Process only up to the last irreversible block to prevent reorg-induced state divergence.
  // This adds ~45s delay (Hive finality = ~15 blocks × 3s) but guarantees all processed
  // operations are final and cannot be reverted by a chain reorganization.
  const irreversibleBlock = chain.irreversibleBlock;
  const headBlock = chain.headBlock;
  const behind = irreversibleBlock - lastBlock;

  // Persist HEAD independently from last_block so /api/multisig can evaluate
  // (hive_head_block − last_block) for its lag gate even when the indexer is
  // actively catching up a large gap. The UPDATE only moves forward.
  await updateHiveHeadBlock(headBlock);

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
    // Backward divergence (expectedStart < current) is recoverable: a crash mid-batch
    // with synchronous_commit=OFF can lose the last_block advance — re-process from DB.
    // Forward divergence (expectedStart > current) means another writer advanced the
    // cursor without us processing those blocks. Silently jumping to expectedStart would
    // skip ops in the gap. This is a data-integrity violation — abort immediately.
    const dbLastBlock = await getLastBlock();
    const expectedStart = dbLastBlock + 1;
    if (expectedStart > current) {
      throw new Error(
        `BLOCK CONTINUITY VIOLATION — DB cursor advanced past us. ` +
        `dbLastBlock=${dbLastBlock} expectedStart=${expectedStart} current=${current}. ` +
        `Refusing to skip blocks ${current}..${expectedStart - 1}.`,
      );
    }
    if (expectedStart < current) {
      continuityFailures++;
      log.error("BLOCK CONTINUITY backward — resetting cursor from DB", {
        expected: expectedStart,
        actual: current,
        dbLastBlock,
        attempt: continuityFailures,
      });
      if (continuityFailures >= MAX_CONTINUITY_FAILURES) {
        throw new Error(
          `Block continuity backward-reset ${continuityFailures} times — aborting cycle`,
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

    // Per-batch lock fence: verify the advisory lock is still held IMMEDIATELY
    // before any state-mutating write. Replaces the previous 30s timer check,
    // which left a ~30s window where a second indexer could race in after a
    // dropped connection and both writers advance the same cursor. Fetching is
    // idempotent read-only I/O so it's safe to run without the lock — only the
    // write path below is guarded. If lost, throw LOCK_LOST_MARKER so syncLoop
    // re-acquires before the next cycle instead of the normal error backoff.
    if (!(await verifyLockHeld())) {
      throw new Error(LOCK_LOST_MARKER);
    }

    // Single transaction per batch. sweepExpiredBuyCommitments runs BEFORE each
    // distinct block's ops so that a `buy` landing at block B observes only
    // locks whose sale_expires_block >= B. It also runs once more at the
    // batch boundary so a quiet window (no ops inside a range that contains
    // an expiration) still returns the NFT to `listed` before the cursor
    // advances. The partial index `idx_nfts_sale_expires` keeps the UPDATE
    // at ~zero cost when no rows are due.
    await withTransaction(async (txn) => {
      if (isMassive && hasOps) {
        await txn`SET LOCAL synchronous_commit = OFF`;
      }

      if (hasOps) {
        let consecutiveFatalFailures = 0;
        let sweptThrough: number | null = null;
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
            if (sweptThrough !== op.blockNum) {
              await sweepExpiredBuyCommitments(op.blockNum, txn);
              sweptThrough = op.blockNum;
            }
            const routeResult = await routeOperationDetailed(op, txn);
            switch (routeResult.kind) {
              case "applied":
              case "rejected":
                consecutiveFatalFailures = 0;
                break;
              case "fatal":
                consecutiveFatalFailures++;
                if (consecutiveFatalFailures >= MAX_CONSECUTIVE_FATAL_ROUTE_FAILURES) {
                  throw new Error(
                    `Circuit breaker: ${consecutiveFatalFailures} consecutive fatal route failures in block range ${batch.from}-${batch.to}`,
                  );
                }
                break;
              default: {
                const exhaustive: never = routeResult;
                throw new Error(`Unhandled route result: ${JSON.stringify(exhaustive)}`);
              }
            }
          }
        }
      }

      // Boundary sweep: ensures the cursor never moves past a block at which a
      // buy_commitment expired without updating the row, even when no op
      // landed in that block. Keyed on lastBatch.to + 1 so
      // `sale_expires_block < X` fires for any commitment whose expiry was
      // <= lastBatch.to.
      await sweepExpiredBuyCommitments(lastBatch.to + 1, txn);
      await updateLastBlock(lastBatch.to, txn);
    });

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
    markSyncActivity();

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

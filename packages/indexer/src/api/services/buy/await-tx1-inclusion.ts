// Waits for the local indexer to confirm that tx1 (sale_lock) was projected
// into the DB. hive-tx's `broadcast(true)` already guarantees the tx is in an
// irreversible block on Hive — this poll only covers the gap between the L1
// inclusion and the indexer's own HafAH pull + handler commit.
//
// If the sale_lock landed with a rejection (e.g. listing got unlisted mid-flight),
// the indexer writes the operation to `invalid_operations` via getOperationStatus.
// Treating that as a fatal pre-tx2 signal is the right thing: we MUST NOT
// co-sign tx2 if the reservation never took effect.
//
// Timeout = 2 × SALE_LOCK_DURATION_BLOCKS × 3000 ms. Block time is 3s on Hive;
// the 2× slack tolerates transient indexer lag without starving tx2 of its TTL.
//
// CONFIDENCE: HIGH on the state transitions (confirmed/invalid/orphaned are
// the only terminal statuses returned by getOperationStatus). MEDIUM on the
// poll cadence — 500ms was chosen to match typical indexer handler latency,
// not benchmarked; tune if production telemetry shows a better fit.

import { getOperationStatus, type OperationStatusResult } from "@/db/queries/sync.ts";
import { ACTION_SALE_LOCK } from "@/protocol/index.ts";
import { createBuyError } from "./errors.ts";

const POLL_INTERVAL_MS = 500;
const BLOCK_TIME_MS = 3000;

export type Tx1InclusionResult = Readonly<{
	readonly txId: string;
	readonly blockNum: number;
	readonly operationId: string;
}>;

export async function awaitTx1Inclusion(
	txId: string,
	saleLockDurationBlocks: number,
): Promise<Tx1InclusionResult> {
	const timeoutMs = 2 * saleLockDurationBlocks * BLOCK_TIME_MS;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const status = await getOperationStatus(txId, undefined, ACTION_SALE_LOCK);
		const terminal = firstTerminalEntry(status);
		if (terminal) return terminal;

		await delay(POLL_INTERVAL_MS);
	}

	throw createBuyError(
		"TX1_INCLUSION_TIMEOUT",
		`sale_lock tx ${txId} was broadcast but the indexer did not confirm it within ${timeoutMs}ms`,
	);
}

function firstTerminalEntry(status: OperationStatusResult): Tx1InclusionResult | null {
	for (const entry of status.operations) {
		if (entry.status === "confirmed") {
			return {
				txId: status.txId,
				blockNum: entry.blockNum ?? 0,
				operationId: entry.operationId ?? `${status.txId}:0`,
			};
		}
		if (entry.status === "invalid" || entry.status === "orphaned") {
			// REVIEW: indexer rejected the sale_lock — downstream orchestrator
			// MUST NOT proceed to tx2. The reason is preserved in the error
			// for client observability.
			throw createBuyError(
				"TX1_REJECTED",
				`sale_lock tx ${status.txId} was rejected by the indexer: ${entry.reason ?? "no reason provided"}`,
			);
		}
	}
	return null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

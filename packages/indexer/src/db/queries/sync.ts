import { sql, type Queryable } from "@/db/client.ts";

const PG_TEXT_OID = 25;

export async function getLastBlockForUpdate(txn: Queryable): Promise<number> {
	const [row] = await txn`SELECT last_block FROM sync_state WHERE id = 1 FOR UPDATE`;
	return Number(row?.last_block ?? 0);
}

export async function getLastBlock(): Promise<number> {
	const [row] = await sql`SELECT last_block FROM sync_state WHERE id = 1`;
	return Number(row?.last_block ?? 0);
}

export interface SyncStatus {
	lastBlock: number;
	updatedAt: Date | null;
}

export async function getSyncStatus(): Promise<SyncStatus> {
	const [row] = await sql`SELECT last_block, updated_at FROM sync_state WHERE id = 1`;
	return {
		lastBlock: Number(row?.last_block ?? 0),
		updatedAt: row?.updated_at ? new Date(String(row.updated_at)) : null,
	};
}

export async function updateLastBlock(blockNum: number, txn: Queryable = sql): Promise<void> {
	await txn`
		UPDATE sync_state
		SET last_block = ${blockNum}, updated_at = NOW()
		WHERE id = 1 AND last_block < ${blockNum}
	`;
}

export async function insertInvalidOperation(
	op: {
		blockNum: number;
		txId: string | null;
		operationId: string | null;
		signer: string | null;
		action: string | null;
		reason: string;
		rawPayload: unknown;
	},
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO invalid_operations (block_num, tx_id, operation_id, signer, action, reason, raw_payload)
		VALUES (
			${op.blockNum},
			${op.txId},
			${op.operationId},
			${op.signer},
			${op.action},
			${op.reason},
			${JSON.stringify(op.rawPayload)}
		)
		ON CONFLICT DO NOTHING
	`;
}

// ============ CONFIRMED OPERATIONS ============

/**
 * Fast existence check keyed on the PK. Used by the router to skip handler
 * dispatch when an op has already been processed (e.g. crash-replay under
 * `synchronous_commit=OFF`). Without this gate, replaying a successful
 * transfer/buy re-adjusts owner_nft_counts and collection_stats, drifting
 * the denormalized counters.
 */
export async function isOperationConfirmed(
	operationId: string,
	txn: Queryable = sql,
): Promise<boolean> {
	const [row] = await txn`
		SELECT 1 AS ok FROM confirmed_operations WHERE operation_id = ${operationId}
	`;
	return row !== undefined;
}

export async function insertConfirmedOperation(
	op: {
		operationId: string;
		txId: string;
		blockNum: number;
		signer: string;
		action: string;
		nftIds: ReadonlyArray<string>;
		createdAt: string;
	},
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO confirmed_operations (operation_id, tx_id, block_num, signer, action, nft_ids, created_at)
		VALUES (
			${op.operationId},
			${op.txId},
			${op.blockNum},
			${op.signer},
			${op.action},
			${sql.array([...op.nftIds], PG_TEXT_OID)},
			${op.createdAt}
		)
		ON CONFLICT (operation_id) DO NOTHING
	`;
}

// ============ EXPIRED OPERATIONS CLEANUP ============

const RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
// confirmed_operations is primarily the crash-replay idempotency index for the
// router. 2 days comfortably covers any realistic sync stall: a crash + restart
// replays at most the un-committed tail, which is minutes to hours, not days.
// Keeping longer just bloats the table without strengthening the guarantee —
// the blockchain is the source of truth for historical operation lookups.
const CONFIRMED_OPS_RETENTION_MS = RETENTION_MS;

export async function cleanupExpiredOperations(): Promise<number> {
	const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
	const confirmedCutoff = new Date(Date.now() - CONFIRMED_OPS_RETENTION_MS).toISOString();
	const invalid = await sql`
		DELETE FROM invalid_operations WHERE indexed_at < ${cutoff}
		RETURNING 1
	`;
	const orphaned = await sql`
		DELETE FROM orphaned_buys WHERE created_at < ${cutoff}
		RETURNING 1
	`;
	const confirmed = await sql`
		DELETE FROM confirmed_operations WHERE created_at < ${confirmedCutoff}
		RETURNING 1
	`;
	return invalid.length + orphaned.length + confirmed.length;
}

// ============ OPERATION STATUS ============

export type OperationStatus = "confirmed" | "invalid" | "orphaned" | "unknown";

export interface OperationStatusEntry {
	status: OperationStatus;
	operationId: string | null;
	signer: string | null;
	action: string | null;
	reason: string | null;
	blockNum: number | null;
	timestamp: string | null;
	nftIds: ReadonlyArray<string>;
}

export interface OperationStatusResult {
	txId: string;
	totalOperations: number;
	confirmed: number;
	invalid: number;
	orphaned: number;
	operations: ReadonlyArray<OperationStatusEntry>;
}

/**
 * Returns all protocol operation statuses for a given Hive transaction.
 *
 * A single Hive tx can contain multiple custom_json operations (up to 5).
 * This function returns one entry per operation, so the caller can distinguish
 * mixed results (e.g., 1 confirmed + 1 invalid within the same tx).
 *
 * Optionally filters by operationId and/or action.
 * For confirmed operations, includes the IDs of NFTs affected when storing the
 * list is bounded. Bulk creation operations may intentionally return [].
 */
export async function getOperationStatus(
	txId: string,
	filterOperationId?: string,
	filterAction?: string,
): Promise<OperationStatusResult> {
	const results: OperationStatusEntry[] = [];

	// 1. Check invalid_operations (may have multiple per tx)
	const invalids = await sql`
		SELECT operation_id, signer, action, reason, block_num, indexed_at
		FROM invalid_operations WHERE tx_id = ${txId}
	`;
	for (const row of invalids) {
		results.push({
			status: "invalid",
			operationId: row.operation_id ?? null,
			signer: row.signer ?? null,
			action: row.action ?? null,
			reason: row.reason ?? null,
			blockNum: Number(row.block_num),
			timestamp: String(row.indexed_at),
			nftIds: [],
		});
	}

	// 2. Check orphaned_buys (may have multiple per tx)
	const orphaneds = await sql`
		SELECT operation_id, buyer, nft_id, reason, block_num, created_at
		FROM orphaned_buys WHERE tx_id = ${txId}
	`;
	for (const row of orphaneds) {
		results.push({
			status: "orphaned",
			operationId: row.operation_id ?? null,
			signer: row.buyer ?? null,
			action: "buy",
			reason: row.reason ?? null,
			blockNum: Number(row.block_num),
			timestamp: String(row.created_at),
			nftIds: row.nft_id ? [String(row.nft_id)] : [],
		});
	}

	// 3. Check confirmed_operations using the immutable nft_ids snapshot captured
	// at confirmation time. Bulk creation ops may intentionally store [] because
	// each NFT row stores its own immutable origin.
	const confirmed = await sql`
		SELECT c.operation_id, c.signer, c.action, c.block_num, c.created_at, c.nft_ids
		FROM confirmed_operations c
		WHERE c.tx_id = ${txId}
	`;
	for (const row of confirmed) {
		const nftIds = Array.isArray(row.nft_ids)
			? row.nft_ids.map(nftId => String(nftId))
			: [];
		results.push({
			status: "confirmed",
			operationId: row.operation_id ?? null,
			signer: row.signer ?? null,
			action: row.action ?? null,
			reason: null,
			blockNum: Number(row.block_num),
			timestamp: String(row.created_at),
			nftIds,
		});
	}

	// Apply filters
	const filtered = results.filter(e =>
		(!filterOperationId || e.operationId === filterOperationId)
		&& (!filterAction || e.action === filterAction),
	);

	const countByStatus = (s: OperationStatus) => filtered.filter(e => e.status === s).length;

	return {
		txId,
		totalOperations: filtered.length,
		confirmed: countByStatus("confirmed"),
		invalid: countByStatus("invalid"),
		orphaned: countByStatus("orphaned"),
		operations: filtered.length > 0 ? filtered : [{
			status: "unknown" as OperationStatus,
			operationId: null,
			signer: null,
			action: null,
			reason: null,
			blockNum: null,
			timestamp: null,
			nftIds: [],
		}],
	};
}

// ============ ORPHANED BUYS ============

export interface OrphanedBuyTransfer {
	from: string;
	to: string;
	amount: number;
	currency: string;
	memo: string;
}

export async function insertOrphanedBuy(
	op: {
		blockNum: number;
		txId: string;
		operationId: string | null;
		buyer: string;
		nftId: string | null;
		reason: string;
		transfers: ReadonlyArray<OrphanedBuyTransfer>;
	},
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO orphaned_buys (block_num, tx_id, operation_id, buyer, nft_id, reason, transfers)
		VALUES (
			${op.blockNum},
			${op.txId},
			${op.operationId},
			${op.buyer},
			${op.nftId},
			${op.reason},
			${JSON.stringify(op.transfers)}
		)
		ON CONFLICT DO NOTHING
	`;
}

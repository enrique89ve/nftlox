import { sql, toJsonb, type Queryable } from "@/db/client.ts";

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

export interface ChainTimeSnapshot {
	lastBlock: number;
	hiveHeadBlock: number;
	hiveHeadTime: string | null;
}

export async function getSyncStatus(): Promise<SyncStatus> {
	const [row] = await sql`SELECT last_block, updated_at FROM sync_state WHERE id = 1`;
	return {
		lastBlock: Number(row?.last_block ?? 0),
		updatedAt: row?.updated_at ? new Date(String(row.updated_at)) : null,
	};
}

export async function getChainTimeSnapshot(
	txn: Queryable = sql,
): Promise<ChainTimeSnapshot> {
	const [row] = await txn`
		SELECT last_block, hive_head_block, hive_head_time
		FROM sync_state
		WHERE id = 1
	`;
	return {
		lastBlock: Number(row?.last_block ?? 0),
		hiveHeadBlock: Number(row?.hive_head_block ?? 0),
		hiveHeadTime: row?.hive_head_time
			? new Date(String(row.hive_head_time)).toISOString()
			: null,
	};
}

export async function updateLastBlock(blockNum: number, txn: Queryable = sql): Promise<void> {
	await txn`
		UPDATE sync_state
		SET last_block = ${blockNum}, updated_at = NOW()
		WHERE id = 1 AND last_block < ${blockNum}
	`;
}

/**
 * Persists the latest observed Hive HEAD block. Read by /api/multisig/buy to
 * enforce the lag gate: if (hive_head_block - last_block) > BUY_API_LAG_MAX_BLOCKS,
 * signing is refused. Updated each sync cycle after the chain-consensus fetch,
 * independently from last_block so the lag signal stays fresh even when the
 * indexer is actively catching up on a large gap.
 */
export async function updateHiveHeadBlock(
	blockNum: number,
	headTime: string | null = null,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE sync_state
		SET hive_head_block = ${blockNum},
		    hive_head_time = ${headTime}
		WHERE id = 1
		  AND (
			hive_head_block < ${blockNum}
			OR (${headTime}::timestamptz IS NOT NULL AND hive_head_time IS NULL)
		  )
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
			${toJsonb(op.rawPayload)}
		)
		ON CONFLICT DO NOTHING
	`;
}

// ============ CONFIRMED OPERATIONS ============

/**
 * Fast existence check keyed on the PK. Used by the router to skip handler
 * dispatch when an op has already been processed during crash-replay. Without
 * this gate, replaying a successful transfer/buy re-adjusts owner_nft_counts
 * and collection_stats, drifting the denormalized counters.
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
// confirmed_operations is durable provenance, not ephemeral retention data:
// nfts.owner_operation_id / nfts.created_operation_id and auditor invariants
// intentionally join back to it. Only invalid/orphaned diagnostic rows expire.

// Hard cap per ephemeral retention table. Time-based TTL alone does not bound row count:
// a bot flooding malformed ops can inflate `invalid_operations` faster than the
// 2-day window evicts (e.g. 10 rps of invalids = ~1.7M rows before cutoff). This
// cap ensures we always shed the oldest surplus so indexes stay small and the
// retention job itself stays O(log n) on the ordering column.
export const MAX_ROWS_PER_TABLE = 100_000;

type RetentionSpec = Readonly<{
	table: "invalid_operations" | "orphaned_buys";
	pkColumn: "id";
	timeColumn: "indexed_at" | "created_at";
}>;

async function pruneExcessRows(spec: RetentionSpec): Promise<number> {
	// Identifiers must be inlined with sql.unsafe — postgres.js only parameterizes
	// literals, not table/column names. The RetentionSpec type is a closed union so
	// no user-controlled string ever reaches this point.
	const { table, pkColumn, timeColumn } = spec;
	const [countRow] = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${table}`);
	const current = Number(countRow?.c ?? 0);
	const excess = current - MAX_ROWS_PER_TABLE;
	if (excess <= 0) return 0;
	// Delete the oldest `excess` rows in a single statement. Using `pk IN (SELECT
	// ... LIMIT excess)` means PG never materializes the full row set in memory —
	// the planner drives the delete from the index scan on `timeColumn`.
	const deleted = await sql.unsafe(`
		DELETE FROM ${table}
		WHERE ${pkColumn} IN (
			SELECT ${pkColumn} FROM ${table}
			ORDER BY ${timeColumn} ASC
			LIMIT ${excess}
		)
		RETURNING 1
	`);
	return deleted.length;
}

export async function cleanupExpiredOperations(): Promise<number> {
	const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
	const invalid = await sql`
		DELETE FROM invalid_operations WHERE indexed_at < ${cutoff}
		RETURNING 1
	`;
	const orphaned = await sql`
		DELETE FROM orphaned_buys WHERE created_at < ${cutoff}
		RETURNING 1
	`;
	const [invalidExcess, orphanedExcess] = await Promise.all([
		pruneExcessRows({ table: "invalid_operations", pkColumn: "id", timeColumn: "indexed_at" }),
		pruneExcessRows({ table: "orphaned_buys", pkColumn: "id", timeColumn: "created_at" }),
	]);
	return (
		invalid.length + orphaned.length
		+ invalidExcess + orphanedExcess
	);
}

// ============ OPERATION STATUS ============

export type OperationStatus = "confirmed" | "invalid" | "orphaned";

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
	// False = no rows seen for this txId (not broadcast, still propagating, or
	// never indexed). True = at least one protocol op was recorded.
	indexed: boolean;
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
	const totalOperations = filtered.length;

	return {
		txId,
		indexed: totalOperations > 0,
		totalOperations,
		confirmed: countByStatus("confirmed"),
		invalid: countByStatus("invalid"),
		orphaned: countByStatus("orphaned"),
		operations: filtered,
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
			${toJsonb(op.transfers)}
		)
		ON CONFLICT DO NOTHING
	`;
}

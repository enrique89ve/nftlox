import { sql, type Queryable } from "@/db/client.ts";

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

export async function insertConfirmedOperation(
	op: {
		operationId: string;
		txId: string;
		blockNum: number;
		signer: string;
		action: string;
		createdAt: string;
	},
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO confirmed_operations (operation_id, tx_id, block_num, signer, action, created_at)
		VALUES (${op.operationId}, ${op.txId}, ${op.blockNum}, ${op.signer}, ${op.action}, ${op.createdAt})
		ON CONFLICT (operation_id) DO NOTHING
	`;
}

// ============ EXPIRED OPERATIONS CLEANUP ============

const RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day

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
	return invalid.length + orphaned.length;
}

// ============ OPERATION STATUS ============

export type OperationStatus = "confirmed" | "invalid" | "orphaned" | "pending" | "unknown";

export interface OperationStatusEntry {
	status: OperationStatus;
	operationId: string | null;
	signer: string | null;
	action: string | null;
	reason: string | null;
	blockNum: number | null;
	timestamp: string | null;
}

/**
 * Returns all protocol operation statuses for a given Hive transaction.
 *
 * A single Hive tx can contain multiple custom_json operations (up to 5).
 * This function returns one entry per operation, so the caller can distinguish
 * mixed results (e.g., 1 confirmed + 1 invalid within the same tx).
 *
 * If no operations are found, returns a single "unknown" entry.
 */
export async function getOperationStatus(txId: string): Promise<OperationStatusEntry[]> {
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
		});
	}

	// 2. Check orphaned_buys (may have multiple per tx)
	const orphaneds = await sql`
		SELECT operation_id, buyer, reason, block_num, created_at
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
		});
	}

	// 3. Check confirmed_operations for successful handler executions.
	// This is the authoritative source: tracks operationId and the real protocol action.
	const confirmed = await sql`
		SELECT operation_id, signer, action, block_num, created_at
		FROM confirmed_operations WHERE tx_id = ${txId}
	`;
	for (const row of confirmed) {
		results.push({
			status: "confirmed",
			operationId: row.operation_id ?? null,
			signer: row.signer ?? null,
			action: row.action ?? null,
			reason: null,
			blockNum: Number(row.block_num),
			timestamp: String(row.created_at),
		});
	}

	if (results.length === 0) {
		return [{
			status: "unknown",
			operationId: null,
			signer: null,
			action: null,
			reason: null,
			blockNum: null,
			timestamp: null,
		}];
	}

	return results;
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

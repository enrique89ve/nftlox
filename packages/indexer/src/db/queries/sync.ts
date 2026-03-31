import { sql, type Queryable } from "@/db/client.ts";

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
		WHERE id = 1
	`;
}

export async function insertInvalidOperation(
	op: {
		blockNum: number;
		txId: string | null;
		signer: string | null;
		action: string | null;
		reason: string;
		rawPayload: unknown;
	},
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO invalid_operations (block_num, tx_id, signer, action, reason, raw_payload)
		VALUES (
			${op.blockNum},
			${op.txId},
			${op.signer},
			${op.action},
			${op.reason},
			${JSON.stringify(op.rawPayload)}
		)
	`;
}

// ============ EXPIRED OPERATIONS CLEANUP ============

const RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day

export async function cleanupExpiredOperations(): Promise<number> {
	const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
	const [invalid] = await sql`
		DELETE FROM invalid_operations WHERE indexed_at < ${cutoff}
		RETURNING COUNT(*)::int AS count
	`;
	const [orphaned] = await sql`
		DELETE FROM orphaned_buys WHERE created_at < ${cutoff}
		RETURNING COUNT(*)::int AS count
	`;
	return (invalid?.count ?? 0) + (orphaned?.count ?? 0);
}

// ============ OPERATION STATUS ============

export type OperationStatus = "confirmed" | "invalid" | "orphaned" | "pending" | "unknown";

export interface OperationStatusResult {
	status: OperationStatus;
	signer: string | null;
	action: string | null;
	reason: string | null;
	blockNum: number | null;
	timestamp: string | null;
}

export async function getOperationStatus(txId: string): Promise<OperationStatusResult> {
	// 1. Check invalid_operations
	const [invalid] = await sql`
		SELECT signer, action, reason, block_num, indexed_at
		FROM invalid_operations WHERE tx_id = ${txId} LIMIT 1
	`;
	if (invalid) {
		return {
			status: "invalid",
			signer: invalid.signer ?? null,
			action: invalid.action ?? null,
			reason: invalid.reason ?? null,
			blockNum: Number(invalid.block_num),
			timestamp: String(invalid.indexed_at),
		};
	}

	// 2. Check orphaned_buys
	const [orphaned] = await sql`
		SELECT buyer, reason, block_num, created_at
		FROM orphaned_buys WHERE tx_id = ${txId} LIMIT 1
	`;
	if (orphaned) {
		return {
			status: "orphaned",
			signer: orphaned.buyer ?? null,
			action: "buy",
			reason: orphaned.reason ?? null,
			blockNum: Number(orphaned.block_num),
			timestamp: String(orphaned.created_at),
		};
	}

	// 3. Check state tables for successful operations
	const [nft] = await sql`
		SELECT minted_by, nft_type AS action, block_num, created_at
		FROM nfts WHERE tx_id = ${txId} LIMIT 1
	`;
	if (nft) {
		return {
			status: "confirmed",
			signer: nft.minted_by ?? null,
			action: nft.action ?? null,
			reason: null,
			blockNum: Number(nft.block_num),
			timestamp: String(nft.created_at),
		};
	}

	const [collection] = await sql`
		SELECT creator, block_num, created_at
		FROM collections WHERE tx_id = ${txId} LIMIT 1
	`;
	if (collection) {
		return {
			status: "confirmed",
			signer: collection.creator ?? null,
			action: "create_collection",
			reason: null,
			blockNum: Number(collection.block_num),
			timestamp: String(collection.created_at),
		};
	}

	return {
		status: "unknown",
		signer: null,
		action: null,
		reason: null,
		blockNum: null,
		timestamp: null,
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
		buyer: string;
		nftId: string | null;
		reason: string;
		transfers: ReadonlyArray<OrphanedBuyTransfer>;
	},
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO orphaned_buys (block_num, tx_id, buyer, nft_id, reason, transfers)
		VALUES (
			${op.blockNum},
			${op.txId},
			${op.buyer},
			${op.nftId},
			${op.reason},
			${JSON.stringify(op.transfers)}
		)
	`;
}

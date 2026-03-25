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

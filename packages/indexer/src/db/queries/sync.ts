import { sql, type Queryable } from "../client.ts";

export async function getLastBlock(): Promise<number> {
	const [row] = await sql`SELECT last_block FROM sync_state WHERE id = 1`;
	return Number(row?.last_block ?? 0);
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

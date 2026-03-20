import { sql, type Queryable, clampLimit } from "@/db/client.ts";
import type { HistoryEventType } from "@/protocol.ts";

export interface InsertHistoryParams {
	nftId: string;
	collectionId: string | null;
	eventType: HistoryEventType;
	blockNum: number;
	txId: string;
	timestamp: string;
	fromAccount: string | null;
	toAccount: string | null;
	priceAmount: number | null;
	priceCurrency: string | null;
	payload: unknown | null;
}

export async function insertHistoryEvent(params: InsertHistoryParams, txn: Queryable = sql): Promise<void> {
	await txn`
		INSERT INTO history_events (
			nft_id, collection_id, event_type,
			block_num, tx_id, timestamp,
			from_account, to_account,
			price_amount, price_currency, payload
		) VALUES (
			${params.nftId}, ${params.collectionId}, ${params.eventType},
			${params.blockNum}, ${params.txId}, ${params.timestamp},
			${params.fromAccount}, ${params.toAccount},
			${params.priceAmount}, ${params.priceCurrency},
			${params.payload ? JSON.stringify(params.payload) : null}
		)
		ON CONFLICT (block_num, tx_id, event_type, nft_id) DO NOTHING
	`;
}

export async function getNftHistory(nftId: string, limit = 100, offset = 0, cursor?: number) {
	const safeLimit = clampLimit(limit, 100);
	if (cursor !== undefined) {
		return sql`
			SELECT * FROM history_events
			WHERE nft_id = ${nftId} AND id > ${cursor}
			ORDER BY id ASC
			LIMIT ${safeLimit}
		`;
	}
	return sql`
		SELECT * FROM history_events
		WHERE nft_id = ${nftId}
		ORDER BY block_num ASC, id ASC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getNftOwnershipChain(nftId: string) {
	return sql`
		SELECT from_account, to_account, event_type, timestamp, block_num, tx_id,
			price_amount, price_currency
		FROM history_events
		WHERE nft_id = ${nftId}
			AND event_type IN ('mint', 'transfer', 'buy', 'distribute')
		ORDER BY block_num ASC, id ASC
	`;
}

export async function getRecentSales(limit = 50, offset = 0, cursor?: number) {
	const safeLimit = clampLimit(limit);
	if (cursor !== undefined) {
		return sql`
			SELECT h.*, n.name AS nft_name, n.image_url AS nft_image_url,
				n.collection_id
			FROM history_events h
			JOIN nfts n ON n.id = h.nft_id
			WHERE h.event_type = 'buy' AND h.id < ${cursor}
			ORDER BY h.id DESC
			LIMIT ${safeLimit}
		`;
	}
	return sql`
		SELECT h.*, n.name AS nft_name, n.image_url AS nft_image_url,
			n.collection_id
		FROM history_events h
		JOIN nfts n ON n.id = h.nft_id
		WHERE h.event_type = 'buy'
		ORDER BY h.block_num DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getUserActivity(username: string, limit = 50, offset = 0, cursor?: number) {
	const safeLimit = clampLimit(limit);
	if (cursor !== undefined) {
		return sql`
			SELECT * FROM history_events
			WHERE (from_account = ${username} OR to_account = ${username})
				AND id < ${cursor}
			ORDER BY id DESC
			LIMIT ${safeLimit}
		`;
	}
	return sql`
		SELECT * FROM history_events
		WHERE from_account = ${username} OR to_account = ${username}
		ORDER BY block_num DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

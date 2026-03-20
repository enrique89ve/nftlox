import { sql, type Queryable, clampLimit } from "@/db/client.ts";

export interface InsertOfferParams {
	id: string;
	nftId: string;
	offerer: string;
	priceAmount: number;
	priceCurrency: string;
	expiresAt: string | null;
	blockNum: number;
	txId: string;
	createdAt: string;
}

export async function insertOffer(params: InsertOfferParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO offers (
			id, nft_id, offerer, price_amount, price_currency,
			expires_at, block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.nftId}, ${params.offerer},
			${params.priceAmount}, ${params.priceCurrency},
			${params.expiresAt}, ${params.blockNum}, ${params.txId},
			${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	return result.count > 0;
}

export async function getOfferById(id: string, txn: Queryable = sql) {
	const [row] = await txn`SELECT * FROM offers WHERE id = ${id}`;
	return row ?? null;
}

export async function updateOfferStatus(
	offerId: string,
	status: "accepted" | "rejected" | "expired",
	txn: Queryable = sql,
) {
	await txn`
		UPDATE offers
		SET status = ${status}, resolved_at = NOW()
		WHERE id = ${offerId}
	`;
}

export async function getOffersByNft(nftId: string, status?: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	if (status) {
		return sql`
			SELECT * FROM offers
			WHERE nft_id = ${nftId} AND status = ${status}
			ORDER BY created_at DESC
			LIMIT ${safeLimit} OFFSET ${offset}
		`;
	}
	return sql`
		SELECT * FROM offers
		WHERE nft_id = ${nftId}
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getOffersByOfferer(offerer: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT * FROM offers
		WHERE offerer = ${offerer}
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

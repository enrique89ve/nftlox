import { sql, type Queryable, clampLimit } from "@/db/client.ts";

// ============ SALES ============

export interface InsertSaleParams {
	assetId: string;
	collectionId: string;
	listingId: string;
	seller: string;
	buyer: string;
	grossAmount: number;
	currency: string;
	royaltyAmount: number;
	protocolFee: number;
	sellerNet: number;
	blockNum: number;
	txId: string;
	createdAt: string;
}

export async function insertSale(params: InsertSaleParams, txn: Queryable = sql): Promise<void> {
	await txn`
		INSERT INTO sales (
			asset_id, collection_id, listing_id,
			seller, buyer,
			gross_amount, currency, royalty_amount, protocol_fee, seller_net,
			block_num, tx_id, created_at
		) VALUES (
			${params.assetId}, ${params.collectionId}, ${params.listingId},
			${params.seller}, ${params.buyer},
			${params.grossAmount}, ${params.currency},
			${params.royaltyAmount}, ${params.protocolFee}, ${params.sellerNet},
			${params.blockNum}, ${params.txId}, ${params.createdAt}
		)
		ON CONFLICT (asset_id, listing_id, tx_id) DO NOTHING
	`;
}

// ============ SALES QUERIES (API) ============

const SALE_COLUMNS = sql`
	asset_id, collection_id, listing_id, seller, buyer,
	gross_amount, currency, royalty_amount, protocol_fee, seller_net,
	tx_id, created_at
`;

export async function getSalesByCollection(collectionId: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT ${SALE_COLUMNS} FROM sales
		WHERE collection_id = ${collectionId}
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getSalesByAsset(assetId: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT ${SALE_COLUMNS} FROM sales
		WHERE asset_id = ${assetId}
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getSalesByAccount(account: string, role: "seller" | "buyer", limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	const filter = role === "seller"
		? sql`seller = ${account}`
		: sql`buyer = ${account}`;
	return sql`
		SELECT ${SALE_COLUMNS} FROM sales
		WHERE ${filter}
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getRecentSales(limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT ${SALE_COLUMNS} FROM sales
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getSalesVolume(collectionId?: string) {
	const filter = collectionId
		? sql`WHERE collection_id = ${collectionId}`
		: sql``;
	return sql`
		SELECT currency,
			COUNT(*)::int AS total_sales,
			SUM(gross_amount)::numeric AS volume,
			SUM(royalty_amount)::numeric AS total_royalties,
			SUM(protocol_fee)::numeric AS total_fees
		FROM sales
		${filter}
		GROUP BY currency
	`;
}

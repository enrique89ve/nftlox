import { sql, type Queryable, clampLimit } from "@/db/client.ts";

// ============ TYPES ============

export interface InsertPackParams {
	id: string;
	collectionId: string;
	creator: string;
	name: string;
	description: string | null;
	imageUrl: string | null;
	dropTable: Array<{ seedId: string; weight: number }>;
	itemsPerPack: number;
	priceAmount: number | null;
	priceCurrency: string | null;
	maxSupply: number;
	blockNum: number;
	txId: string;
	createdAt: string;
}

export interface PackProcessingRow {
	id: string;
	collection_id: string;
	creator: string;
	name: string;
	drop_table: Array<{ seedId: string; weight: number }>;
	items_per_pack: number;
	price_amount: string | null;
	price_currency: string | null;
	max_supply: number;
	current_supply: number;
	total_opened: number;
	status: string;
}

// ============ CORE QUERIES ============

export async function insertPack(params: InsertPackParams, txn: Queryable = sql): Promise<boolean> {
	const result = await txn`
		INSERT INTO packs (
			id, collection_id, creator, name, description, image_url,
			drop_table, items_per_pack,
			price_amount, price_currency,
			max_supply, block_num, tx_id, created_at
		) VALUES (
			${params.id}, ${params.collectionId}, ${params.creator},
			${params.name}, ${params.description}, ${params.imageUrl},
			${JSON.stringify(params.dropTable)}, ${params.itemsPerPack},
			${params.priceAmount}, ${params.priceCurrency},
			${params.maxSupply}, ${params.blockNum}, ${params.txId}, ${params.createdAt}
		)
		ON CONFLICT (id) DO NOTHING
	`;
	return result.count > 0;
}

export async function getPackById(id: string) {
	const [row] = await sql`SELECT * FROM packs WHERE id = ${id}`;
	return row ?? null;
}

export async function packExists(id: string, txn: Queryable = sql): Promise<boolean> {
	const [row] = await txn`SELECT 1 FROM packs WHERE id = ${id}`;
	return !!row;
}

export async function getPackForProcessing(
	id: string,
	txn: Queryable = sql,
): Promise<PackProcessingRow | null> {
	const [row] = await txn<PackProcessingRow[]>`
		SELECT id, collection_id, creator, name, drop_table,
			items_per_pack, price_amount, price_currency,
			max_supply, current_supply, total_opened, status
		FROM packs WHERE id = ${id}
	`;
	return row ?? null;
}

// ============ BALANCE QUERIES ============

export async function upsertPackBalance(
	account: string,
	packId: string,
	delta: number,
	txn: Queryable = sql,
): Promise<void> {
	if (delta < 0) {
		// UPDATE only — avoids CHECK constraint violation on INSERT with negative value
		await txn`
			UPDATE user_pack_balances
			SET balance = balance + ${delta}
			WHERE account = ${account} AND pack_id = ${packId}
		`;
	} else {
		await txn`
			INSERT INTO user_pack_balances (account, pack_id, balance)
			VALUES (${account}, ${packId}, ${delta})
			ON CONFLICT (account, pack_id)
			DO UPDATE SET balance = user_pack_balances.balance + ${delta}
		`;
	}
}

export async function getPackBalance(
	account: string,
	packId: string,
	txn: Queryable = sql,
): Promise<number> {
	const [row] = await txn`
		SELECT balance FROM user_pack_balances
		WHERE account = ${account} AND pack_id = ${packId}
	`;
	return Number(row?.balance ?? 0);
}

// ============ SUPPLY QUERIES ============

export async function incrementPackSupply(
	packId: string,
	quantity: number,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE packs
		SET current_supply = current_supply + ${quantity}
		WHERE id = ${packId}
	`;
}

export async function incrementPackOpened(
	packId: string,
	quantity: number,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE packs
		SET total_opened = total_opened + ${quantity}
		WHERE id = ${packId}
	`;
}

export async function updatePackStatus(
	packId: string,
	status: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		UPDATE packs SET status = ${status} WHERE id = ${packId}
	`;
}

// ============ API QUERIES ============

export async function listPacks(collectionId?: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	if (collectionId) {
		return sql`
			SELECT * FROM packs
			WHERE collection_id = ${collectionId}
			ORDER BY created_at DESC
			LIMIT ${safeLimit} OFFSET ${offset}
		`;
	}
	return sql`
		SELECT * FROM packs
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getPacksByCreator(creator: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT * FROM packs
		WHERE creator = ${creator}
		ORDER BY created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

export async function getUserPackBalances(account: string, limit = 50, offset = 0) {
	const safeLimit = clampLimit(limit);
	return sql`
		SELECT upb.account, upb.pack_id, upb.balance,
			p.name, p.description, p.image_url, p.collection_id,
			p.items_per_pack, p.price_amount, p.price_currency,
			p.max_supply, p.current_supply, p.status
		FROM user_pack_balances upb
		JOIN packs p ON p.id = upb.pack_id
		WHERE upb.account = ${account} AND upb.balance > 0
		ORDER BY p.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}


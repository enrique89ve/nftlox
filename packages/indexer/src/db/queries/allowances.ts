import { sql, type Queryable } from "@/db/client.ts";

// ============ Asset ALLOWANCES (ERC-721 style) ============

export async function upsertAssetAllowance(
	assetId: string,
	owner: string,
	approvedSpender: string,
	blockNum: number,
	txId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO asset_allowances (asset_id, owner, approved_spender, block_num, tx_id)
		VALUES (${assetId}, ${owner}, ${approvedSpender}, ${blockNum}, ${txId})
		ON CONFLICT (asset_id)
		DO UPDATE SET
			owner = ${owner},
			approved_spender = ${approvedSpender},
			block_num = ${blockNum},
			tx_id = ${txId},
			updated_at = NOW()
	`;
}

export async function deleteAssetAllowance(
	assetId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`DELETE FROM asset_allowances WHERE asset_id = ${assetId}`;
}

export async function getAssetAllowance(
	assetId: string,
	txn: Queryable = sql,
): Promise<string | null> {
	const [row] = await txn`
		SELECT approved_spender FROM asset_allowances WHERE asset_id = ${assetId}
	`;
	return row?.approved_spender ?? null;
}

// ============ COLLECTION ALLOWANCES (ERC-721 setApprovalForAll) ============

export async function upsertCollectionAllowance(
	owner: string,
	spender: string,
	collectionId: string,
	approved: boolean,
	blockNum: number,
	txId: string,
	txn: Queryable = sql,
): Promise<void> {
	if (!approved) {
		await txn`
			DELETE FROM collection_allowances
			WHERE owner = ${owner} AND spender = ${spender} AND collection_id = ${collectionId}
		`;
		return;
	}

	await txn`
		INSERT INTO collection_allowances (owner, spender, collection_id, approved, block_num, tx_id)
		VALUES (${owner}, ${spender}, ${collectionId}, TRUE, ${blockNum}, ${txId})
		ON CONFLICT (owner, spender, collection_id)
		DO UPDATE SET
			approved = TRUE,
			block_num = ${blockNum},
			tx_id = ${txId},
			updated_at = NOW()
	`;
}

export async function hasCollectionAllowance(
	owner: string,
	spender: string,
	collectionId: string,
	txn: Queryable = sql,
): Promise<boolean> {
	const [row] = await txn`
		SELECT 1 FROM collection_allowances
		WHERE owner = ${owner} AND spender = ${spender}
			AND collection_id = ${collectionId} AND approved = TRUE
	`;
	return !!row;
}

export async function cleanupCollectionAllowancesIfEmpty(
	owner: string,
	collectionId: string,
	txn: Queryable = sql,
): Promise<void> {
	const [row] = await txn`
		SELECT 1 FROM assets
		WHERE owner = ${owner} AND collection_id = ${collectionId}
		LIMIT 1
	`;
	if (!row) {
		await txn`
			DELETE FROM collection_allowances
			WHERE owner = ${owner} AND collection_id = ${collectionId}
		`;
	}
}

// ============ DATA OPERATORS ============

export async function upsertDataOperator(
	collectionId: string,
	operator: string,
	blockNum: number,
	txId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO data_operators (collection_id, operator, block_num, tx_id)
		VALUES (${collectionId}, ${operator}, ${blockNum}, ${txId})
		ON CONFLICT (collection_id, operator)
		DO UPDATE SET
			block_num = ${blockNum},
			tx_id = ${txId},
			updated_at = NOW()
	`;
}

export async function deleteDataOperator(
	collectionId: string,
	operator: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		DELETE FROM data_operators
		WHERE collection_id = ${collectionId} AND operator = ${operator}
	`;
}

export async function hasDataOperatorApproval(
	collectionId: string,
	operator: string,
	txn: Queryable = sql,
): Promise<boolean> {
	const [row] = await txn`
		SELECT 1 FROM data_operators
		WHERE collection_id = ${collectionId} AND operator = ${operator}
	`;
	return !!row;
}

import { sql, type Queryable } from "@/db/client.ts";

// ============ NFT ALLOWANCES (ERC-721 style) ============

export async function upsertNftAllowance(
	nftId: string,
	owner: string,
	approvedSpender: string,
	blockNum: number,
	txId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO nft_allowances (nft_id, owner, approved_spender, block_num, tx_id)
		VALUES (${nftId}, ${owner}, ${approvedSpender}, ${blockNum}, ${txId})
		ON CONFLICT (nft_id)
		DO UPDATE SET
			owner = ${owner},
			approved_spender = ${approvedSpender},
			block_num = ${blockNum},
			tx_id = ${txId},
			updated_at = NOW()
	`;
}

export async function deleteNftAllowance(
	nftId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`DELETE FROM nft_allowances WHERE nft_id = ${nftId}`;
}

export async function getNftAllowance(
	nftId: string,
	txn: Queryable = sql,
): Promise<string | null> {
	const [row] = await txn`
		SELECT approved_spender FROM nft_allowances WHERE nft_id = ${nftId}
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

export async function deleteCollectionAllowancesByCollection(
	collectionId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		DELETE FROM collection_allowances
		WHERE collection_id = ${collectionId}
	`;
}

export async function cleanupCollectionAllowancesIfEmpty(
	owner: string,
	collectionId: string,
	txn: Queryable = sql,
): Promise<void> {
	const [row] = await txn`
		SELECT 1 FROM nfts
		WHERE owner = ${owner} AND collection_id = ${collectionId}
			AND status NOT IN ('burned')
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

export async function deleteDataOperatorsByCollection(
	collectionId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		DELETE FROM data_operators
		WHERE collection_id = ${collectionId}
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

// ============ PACK ALLOWANCES (ERC-20 style) ============

export async function upsertPackAllowance(
	owner: string,
	spender: string,
	packId: string,
	quantity: number,
	blockNum: number,
	txId: string,
	txn: Queryable = sql,
): Promise<void> {
	if (quantity === 0) {
		await txn`
			DELETE FROM pack_allowances
			WHERE owner = ${owner} AND spender = ${spender} AND pack_id = ${packId}
		`;
		return;
	}

	await txn`
		INSERT INTO pack_allowances (owner, spender, pack_id, quantity, block_num, tx_id)
		VALUES (${owner}, ${spender}, ${packId}, ${quantity}, ${blockNum}, ${txId})
		ON CONFLICT (owner, spender, pack_id)
		DO UPDATE SET
			quantity = ${quantity},
			block_num = ${blockNum},
			tx_id = ${txId},
			updated_at = NOW()
	`;
}

export async function getPackAllowance(
	owner: string,
	spender: string,
	packId: string,
	txn: Queryable = sql,
): Promise<number> {
	const [row] = await txn`
		SELECT quantity FROM pack_allowances
		WHERE owner = ${owner} AND spender = ${spender} AND pack_id = ${packId}
	`;
	return Number(row?.quantity ?? 0);
}

export async function deductPackAllowance(
	owner: string,
	spender: string,
	packId: string,
	quantity: number,
	txn: Queryable = sql,
): Promise<void> {
	const result = await txn`
		UPDATE pack_allowances
		SET quantity = quantity - ${quantity}, updated_at = NOW()
		WHERE owner = ${owner} AND spender = ${spender} AND pack_id = ${packId}
			AND quantity >= ${quantity}
	`;
	if (result.count === 0) {
		throw new Error("Insufficient pack allowance");
	}
}

import { sql, type Queryable } from "@/db/client.ts";

export interface InsertLoanParams {
	nftId: string;
	lender: string;
	borrower: string;
	blockNum: number;
	txId: string;
}

export async function insertLoan(
	params: InsertLoanParams,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO nft_loans (nft_id, lender, borrower, block_num, tx_id)
		VALUES (${params.nftId}, ${params.lender}, ${params.borrower}, ${params.blockNum}, ${params.txId})
	`;
}

export async function deleteLoan(
	nftId: string,
	txn: Queryable = sql,
): Promise<void> {
	await txn`DELETE FROM nft_loans WHERE nft_id = ${nftId}`;
}

export interface LoanRecord {
	nft_id: string;
	lender: string;
	borrower: string;
	block_num: number;
	tx_id: string;
}

export async function getLoan(
	nftId: string,
	txn: Queryable = sql,
): Promise<LoanRecord | null> {
	const [row] = await txn`
		SELECT nft_id, lender, borrower, block_num, tx_id
		FROM nft_loans WHERE nft_id = ${nftId}
	`;
	if (!row) return null;
	return {
		nft_id: String(row.nft_id),
		lender: String(row.lender),
		borrower: String(row.borrower),
		block_num: Number(row.block_num),
		tx_id: String(row.tx_id),
	};
}

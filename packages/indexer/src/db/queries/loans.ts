import { sql, type Queryable, clampLimit } from "@/db/client.ts";
import type { NftKind, NftStatus, OwnershipAction, Pagination } from "./nft-types.ts";

export type LoanRole = "lender" | "borrower" | "all";

export type NftLoanRow = Readonly<{
	readonly nft_id: string;
	readonly collection_id: string;
	readonly nft_type: NftKind;
	readonly status: NftStatus;
	readonly owner: string;
	readonly name: string;
	readonly image_url: string | null;
	readonly seed_id: string | null;
	readonly seed_tx_id: string | null;
	readonly instance_number: number | null;
	readonly owner_operation_id: string;
	readonly owner_action: OwnershipAction;
	readonly owner_block_num: number;
	readonly lender: string;
	readonly borrower: string;
	readonly loan_operation_id: string;
	readonly loan_block_num: number;
	readonly loan_tx_id: string;
	readonly loan_created_at: string;
}>;

export const VALID_LOAN_ROLES = new Set<LoanRole>(["lender", "borrower", "all"]);

export const parseLoanRole = (value: string | undefined): LoanRole | undefined =>
	value !== undefined && VALID_LOAN_ROLES.has(value as LoanRole) ? value as LoanRole : undefined;

const LOAN_LIST_COLUMNS = sql`
	l.nft_id,
	n.collection_id,
	n.nft_type,
	n.status,
	n.owner,
	COALESCE(NULLIF(n.name, ''), s.name) AS name,
	COALESCE(n.image_url, s.image_url) AS image_url,
	n.seed_id,
	s.created_tx_id AS seed_tx_id,
	n.instance_number,
	n.owner_operation_id,
	n.owner_action,
	n.owner_block_num::int AS owner_block_num,
	l.lender,
	l.borrower,
	l.operation_id AS loan_operation_id,
	l.block_num::int AS loan_block_num,
	l.tx_id AS loan_tx_id,
	l.created_at AS loan_created_at
`;

function loanRoleFilter(username: string, role: LoanRole) {
	switch (role) {
		case "lender":
			return sql`l.lender = ${username}`;
		case "borrower":
			return sql`l.borrower = ${username}`;
		case "all":
			return sql`(l.lender = ${username} OR l.borrower = ${username})`;
	}
}

export interface InsertLoanParams {
	nftId: string;
	lender: string;
	borrower: string;
	operationId: string;
	blockNum: number;
	txId: string;
}

export async function insertLoan(
	params: InsertLoanParams,
	txn: Queryable = sql,
): Promise<void> {
	await txn`
		INSERT INTO nft_loans (nft_id, lender, borrower, operation_id, block_num, tx_id)
		VALUES (${params.nftId}, ${params.lender}, ${params.borrower}, ${params.operationId}, ${params.blockNum}, ${params.txId})
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
	operation_id: string;
	block_num: number;
	tx_id: string;
}

export async function getLoan(
	nftId: string,
	txn: Queryable = sql,
): Promise<LoanRecord | null> {
	const [row] = await txn`
		SELECT nft_id, lender, borrower, operation_id, block_num, tx_id
		FROM nft_loans WHERE nft_id = ${nftId}
	`;
	if (!row) return null;
	return {
		nft_id: String(row.nft_id),
		lender: String(row.lender),
		borrower: String(row.borrower),
		operation_id: String(row.operation_id),
		block_num: Number(row.block_num),
		tx_id: String(row.tx_id),
	};
}

export async function getNftLoan(nftId: string, txn: Queryable = sql): Promise<NftLoanRow | null> {
	const [row] = await txn<NftLoanRow[]>`
		SELECT ${LOAN_LIST_COLUMNS}
		FROM nft_loans l
		JOIN nfts n ON n.id = l.nft_id
		LEFT JOIN nfts s ON s.id = n.seed_id
		WHERE l.nft_id = ${nftId}
	`;
	return row ?? null;
}

export async function countLoansByAccount(
	username: string,
	role: LoanRole,
	txn: Queryable = sql,
): Promise<number> {
	const filter = loanRoleFilter(username, role);
	const [row] = await txn<{ readonly count: number }[]>`
		SELECT COUNT(*)::int AS count
		FROM nft_loans l
		WHERE ${filter}
	`;
	return row?.count ?? 0;
}

export async function queryLoansByAccount(
	username: string,
	role: LoanRole,
	page?: Pagination,
	txn: Queryable = sql,
): Promise<NftLoanRow[]> {
	const safeLimit = clampLimit(page?.limit ?? 50);
	const offset = page?.offset ?? 0;
	const filter = loanRoleFilter(username, role);
	return txn<NftLoanRow[]>`
		SELECT ${LOAN_LIST_COLUMNS}
		FROM nft_loans l
		JOIN nfts n ON n.id = l.nft_id
		LEFT JOIN nfts s ON s.id = n.seed_id
		WHERE ${filter}
		ORDER BY l.created_at DESC
		LIMIT ${safeLimit} OFFSET ${offset}
	`;
}

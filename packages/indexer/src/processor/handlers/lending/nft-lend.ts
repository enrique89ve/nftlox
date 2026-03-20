import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftStatus, NFT_STATUS_ACTIVE, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { insertLoan, getLoan } from "@/db/queries/loans.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleNftLend(op: ParsedOperation, txn: Queryable): Promise<void> {
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const borrower = requireString(op.data.borrower, "borrower");

	if (borrower === op.signer) throw new Error("Cannot lend to yourself");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);
	if (nft.status !== NFT_STATUS_ACTIVE) throw new Error(`NFT must be active to lend, current status: ${nft.status}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${instanceId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable — lending not allowed`);
	}

	const existingLoan = await getLoan(instanceId, txn);
	if (existingLoan) throw new Error(`NFT already lent: ${instanceId}`);

	await updateNftStatus(instanceId, NFT_STATUS_LENT, txn);
	await insertLoan({
		nftId: instanceId,
		lender: op.signer,
		borrower,
		blockNum: op.blockNum,
		txId: op.txId,
	}, txn);

	// Clear any existing approvals — lent NFTs cannot be transferred
	await deleteNftAllowance(instanceId, txn);

	await insertHistoryEvent({
		nftId: instanceId,
		collectionId: nft.collection_id,
		eventType: "nft_lend",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: op.signer,
		toAccount: borrower,
		priceAmount: null,
		priceCurrency: null,
		payload: op.data,
	}, txn);
}

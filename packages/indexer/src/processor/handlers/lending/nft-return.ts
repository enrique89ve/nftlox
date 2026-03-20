import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftStatus, NFT_STATUS_ACTIVE, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { getLoan, deleteLoan } from "@/db/queries/loans.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleNftReturn(op: ParsedOperation, txn: Queryable): Promise<void> {
	const instanceId = requireString(op.data.instanceId, "instanceId");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);
	if (nft.status !== NFT_STATUS_LENT) throw new Error(`NFT is not lent: ${instanceId}`);

	const loan = await getLoan(instanceId, txn);
	if (!loan) throw new Error(`No active loan found for: ${instanceId}`);

	// Both lender and borrower can return
	const isLender = op.signer === loan.lender;
	const isBorrower = op.signer === loan.borrower;
	if (!isLender && !isBorrower) {
		throw new Error(`Signer ${op.signer} is neither lender nor borrower of ${instanceId}`);
	}

	await updateNftStatus(instanceId, NFT_STATUS_ACTIVE, txn);
	await deleteLoan(instanceId, txn);

	await insertHistoryEvent({
		nftId: instanceId,
		collectionId: nft.collection_id,
		eventType: "nft_return",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: op.signer,
		toAccount: loan.lender,
		priceAmount: null,
		priceCurrency: null,
		payload: { ...op.data, returnedBy: isLender ? "lender" : "borrower" },
	}, txn);
}

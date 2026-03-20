import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { upsertNftAllowance, deleteNftAllowance } from "@/db/queries/allowances.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString, requireBoolean } from "@/utils/validation.ts";

export async function handleNftApprove(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireString(op.data.spender, "spender");
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${instanceId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be approved: ${instanceId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${instanceId}`);

	if (approved) {
		await upsertNftAllowance(instanceId, op.signer, spender, op.blockNum, op.txId, txn);
	} else {
		await deleteNftAllowance(instanceId, txn);
	}

	await insertHistoryEvent({
		nftId: instanceId,
		collectionId: nft.collection_id,
		eventType: "nft_approve",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: op.signer,
		toAccount: approved ? spender : null,
		priceAmount: null,
		priceCurrency: null,
		payload: op.data,
	}, txn);
}

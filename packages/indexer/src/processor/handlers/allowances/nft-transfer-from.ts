import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import {
	getNftAllowance,
	hasCollectionAllowance,
	deleteNftAllowance,
} from "@/db/queries/allowances.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleNftTransferFrom(op: ParsedOperation, txn: Queryable): Promise<void> {
	const from = requireString(op.data.from, "from");
	const to = requireString(op.data.to, "to");
	const instanceId = requireString(op.data.instanceId, "instanceId");

	if (from === to) throw new Error("Cannot transfer to yourself");

	const nft = await getNftForProcessing(instanceId, txn);
	if (!nft) throw new Error(`NFT not found: ${instanceId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${instanceId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be transferred: ${instanceId}`);
	if (nft.owner !== from) throw new Error(`Account ${from} is not owner of ${instanceId}`);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable`);
	}

	// Spender authorization: individual NFT approval OR collection-wide approval
	const approvedSpender = await getNftAllowance(instanceId, txn);
	const hasIndividualApproval = approvedSpender === op.signer;
	const hasCollectionApproval = await hasCollectionAllowance(
		from, op.signer, nft.collection_id, txn,
	);

	if (!hasIndividualApproval && !hasCollectionApproval) {
		throw new Error(`Signer ${op.signer} is not approved to transfer ${instanceId}`);
	}

	await updateNftOwner(instanceId, to, txn);
	await deleteNftAllowance(instanceId, txn);

	await insertHistoryEvent({
		nftId: instanceId,
		collectionId: nft.collection_id,
		eventType: "nft_transfer_from",
		blockNum: op.blockNum,
		txId: op.txId,
		timestamp: op.timestamp,
		fromAccount: from,
		toAccount: to,
		priceAmount: null,
		priceCurrency: null,
		payload: { ...op.data, spender: op.signer },
	}, txn);
}

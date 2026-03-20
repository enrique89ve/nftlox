import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftBurned, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleBurn(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT already burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be burned: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	await updateNftBurned(nftId, txn);
	await deleteNftAllowance(nftId, txn);
	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "burn",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: null,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}

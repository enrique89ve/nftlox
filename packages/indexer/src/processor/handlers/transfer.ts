import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner } from "../../db/queries/nfts.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString } from "../../utils/validation.ts";

export async function handleTransfer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const to = requireString(op.data.to, "to");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === "burned") throw new Error(`NFT is burned: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	await updateNftOwner(nftId, to, txn);
	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "transfer",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: to,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}

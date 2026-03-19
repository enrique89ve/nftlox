import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner } from "../../db/queries/nfts.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString } from "../../utils/validation.ts";

export async function handleBuy(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status !== "listed") throw new Error(`NFT not listed: ${nftId}`);
	if (nft.owner === op.signer) throw new Error("Cannot buy own NFT");

	const previousOwner = nft.owner;
	await updateNftOwner(nftId, op.signer, txn);
	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "buy",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: previousOwner, toAccount: op.signer,
		priceAmount: null, priceCurrency: null, payload: op.data,
	}, txn);
}

import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftListing, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString, requirePrice } from "@/utils/validation.ts";

export async function handleList(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const price = requirePrice(op.data.price, "price");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be listed: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const priceAmount = parseFloat(price.amount);
	await updateNftListing(nftId, priceAmount, price.currency, txn);
	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "list",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: null,
		priceAmount, priceCurrency: price.currency, payload: op.data,
	}, txn);
}

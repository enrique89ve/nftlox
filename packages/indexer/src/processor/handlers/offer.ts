import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { getNftForProcessing } from "../../db/queries/nfts.ts";
import { insertOffer } from "../../db/queries/offers.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString, requirePrice, optionalNumber } from "../../utils/validation.ts";

export async function handleOffer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const nftId = requireString(d.nftId, "nftId");
	const price = requirePrice(d.price, "price");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === "burned") throw new Error(`NFT is burned: ${nftId}`);
	if (nft.owner === op.signer) throw new Error("Cannot offer on own NFT");

	const offerId = (typeof d.offerId === "string" && d.offerId) ? d.offerId : `offer_${op.txId.slice(0, 12)}`;
	const expiresAt = optionalNumber(d.expiresAt);

	await insertOffer({
		id: offerId, nftId, offerer: op.signer,
		priceAmount: parseFloat(price.amount), priceCurrency: price.currency,
		expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
		blockNum: op.blockNum, txId: op.txId, createdAt: op.timestamp,
	}, txn);

	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "offer",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: nft.owner,
		priceAmount: parseFloat(price.amount), priceCurrency: price.currency, payload: op.data,
	}, txn);
}

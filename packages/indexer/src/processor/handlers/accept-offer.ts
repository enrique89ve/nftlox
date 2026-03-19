import type { Queryable } from "../../db/client.ts";
import type { ParsedOperation } from "../../scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner } from "../../db/queries/nfts.ts";
import { getOfferById, updateOfferStatus } from "../../db/queries/offers.ts";
import { insertHistoryEvent } from "../../db/queries/history.ts";
import { requireString } from "../../utils/validation.ts";

export async function handleAcceptOffer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const offerId = requireString(op.data.offerId, "offerId");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const offer = await getOfferById(offerId, txn);
	if (!offer) throw new Error(`Offer not found: ${offerId}`);
	if (offer.status !== "active") throw new Error(`Offer not active: ${offerId}`);

	await updateOfferStatus(offerId, "accepted", txn);
	await updateNftOwner(nftId, String(offer.offerer), txn);

	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "offer_accepted",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: String(offer.offerer),
		priceAmount: Number(offer.price_amount), priceCurrency: String(offer.price_currency),
		payload: op.data,
	}, txn);
}

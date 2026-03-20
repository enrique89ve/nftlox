import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftOwner, NFT_STATUS_BURNED, NFT_STATUS_LENT } from "@/db/queries/nfts.ts";
import { getOfferById, updateOfferStatus } from "@/db/queries/offers.ts";
import { deleteNftAllowance } from "@/db/queries/allowances.ts";
import { insertHistoryEvent } from "@/db/queries/history.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleAcceptOffer(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const offerId = requireString(op.data.offerId, "offerId");

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status === NFT_STATUS_BURNED) throw new Error(`NFT is burned: ${nftId}`);
	if (nft.status === NFT_STATUS_LENT) throw new Error(`NFT is lent and cannot be sold: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const offer = await getOfferById(offerId, txn);
	if (!offer) throw new Error(`Offer not found: ${offerId}`);
	if (offer.status !== "active") throw new Error(`Offer not active: ${offerId}`);

	await updateOfferStatus(offerId, "accepted", txn);
	await updateNftOwner(nftId, String(offer.offerer), txn);
	await deleteNftAllowance(nftId, txn);

	await insertHistoryEvent({
		nftId, collectionId: nft.collection_id, eventType: "offer_accepted",
		blockNum: op.blockNum, txId: op.txId, timestamp: op.timestamp,
		fromAccount: op.signer, toAccount: String(offer.offerer),
		priceAmount: Number(offer.price_amount), priceCurrency: String(offer.price_currency),
		payload: op.data,
	}, txn);
}

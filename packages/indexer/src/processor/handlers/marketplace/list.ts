import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftListing, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireHiveAmount, optionalNumber, optionalString } from "@/utils/validation.ts";
import { assertActionable, assertSeedNotDistributed, assertSeedNotReserved, isListingExpired } from "@/utils/status-checks.ts";
import { generateListingId, LISTING_ID_PREFIX, MIN_PRICE_AMOUNT } from "nftlox-sdk";

export async function handleList(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listingNonce = requireString(op.data.listingNonce, "listingNonce");
	const price = requireHiveAmount(op.data.price, "price");
	const expiresAt = optionalNumber(op.data.expiresAt);
	const marketplace = optionalString(op.data.marketplace);

	if (!listingId.startsWith(LISTING_ID_PREFIX)) {
		throw new Error(`Invalid listingId format: must start with '${LISTING_ID_PREFIX}'`);
	}

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	assertActionable(nft, nftId);
	assertSeedNotDistributed(nft, nftId);
	assertSeedNotReserved(nft, nftId);

	const rules = await getCollectionRules(nft.collection_id, txn);
	if (rules && !rules.transferable) {
		throw new Error(`Collection ${nft.collection_id} is not transferable — listing blocked`);
	}

	const hadExpiredListing = nft.status === NFT_STATUS_LISTED && isListingExpired(nft.listing_expires_at, op.timestamp);

	if (nft.status === NFT_STATUS_LISTED && !hadExpiredListing) {
		throw new Error(`NFT is already listed. Unlist first: ${nftId}`);
	}

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	// Verify listingId is correctly computed from the payload fields
	const expectedListingId = await generateListingId({
		nftId,
		owner: op.signer,
		marketplace: marketplace ?? "",
		priceAmount: price.amount,
		priceCurrency: price.currency,
		expiresAt: expiresAt ?? 0,
		nonce: listingNonce,
	});

	if (listingId !== expectedListingId) {
		throw new Error(`listingId mismatch: expected '${expectedListingId}', got '${listingId}'`);
	}

	const priceAmount = parseFloat(price.amount);
	const minPrice = parseFloat(MIN_PRICE_AMOUNT);
	if (priceAmount < minPrice) {
		throw new Error(`Price ${price.amount} ${price.currency} is below minimum ${MIN_PRICE_AMOUNT}`);
	}

	await updateNftListing(nftId, priceAmount, price.currency, expiresAt, marketplace, listingId, op.txId, txn);
}

import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessingForUpdate, updateNftListing, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import type { ListingCtx } from "@/db/queries/nfts.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { requireString, requireHiveAmount, optionalNumber, optionalString } from "@/utils/validation.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { generateListingId, LISTING_ID_PREFIX, MIN_LISTING_TTL_MS, MIN_PRICE_AMOUNT } from "@/protocol/index.ts";

function validateExpiresAt(expiresAt: number | null, blockTimestamp: string, nftId: string): void {
	if (expiresAt === null || expiresAt === 0) return;

	const blockTimestampMs = new Date(blockTimestamp).getTime();
	if (Number.isNaN(blockTimestampMs)) {
		throw new Error(`Invalid block timestamp for listing: ${blockTimestamp}`);
	}
	if (expiresAt <= blockTimestampMs) {
		throw new Error(`Listing expiresAt must be in the future for NFT: ${nftId}`);
	}

	const minimumExpiresAt = blockTimestampMs + MIN_LISTING_TTL_MS;
	if (expiresAt <= minimumExpiresAt) {
		throw new Error(
			`Listing expiresAt is too soon for safe settlement: must be more than ${MIN_LISTING_TTL_MS / 1000}s after the listing block timestamp`,
		);
	}
}

export async function handleList(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listingNonce = requireString(op.data.listingNonce, "listingNonce");
	const price = requireHiveAmount(op.data.price, "price");
	const expiresAt = optionalNumber(op.data.expiresAt);
	const marketplace = optionalString(op.data.marketplace);

	if (!listingId.startsWith(LISTING_ID_PREFIX)) {
		throw new Error(`Invalid listingId format: must start with '${LISTING_ID_PREFIX}'`);
	}

	const nft = await getNftForProcessingForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	await validateSeedProvenance(op, nft, txn);

	assertActionable(nft, nftId);
	assertMarketplaceInstance(nft, nftId);

	validateExpiresAt(expiresAt, op.timestamp, nftId);

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

	const ctx: ListingCtx = {
		collectionId: nft.collection_id,
		wasListed: hadExpiredListing, // re-listing expired → net 0; fresh listing → +1
	};
	await updateNftListing(nftId, priceAmount, price.currency, expiresAt, marketplace, listingId, op.txId, ctx, txn);

	return [nftId];
}

import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getAssetForProcessingForUpdate, updateAssetListing, ASSET_STATUS_LISTED } from "@/db/queries/assets.ts";
import type { ListingCtx } from "@/db/queries/assets.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { deleteAssetAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireHiveAmount, requireNumber, optionalBoundedString } from "@/utils/validation.ts";
import { assertActionable, assertMarketplaceInstance, isListingExpired } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import {
	generateListingId,
	LISTING_ID_PREFIX,
	MAX_MARKETPLACE_LENGTH,
	MIN_LISTING_TTL_MS,
	MAX_LISTING_TTL_MS,
	MIN_PRICE_AMOUNT,
} from "@/protocol/index.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

function validateExpiresAt(expiresAt: number, blockTimestamp: string, assetId: string): void {
	const blockTimestampMs = new Date(blockTimestamp).getTime();
	if (Number.isNaN(blockTimestampMs)) {
		throw protocolReject(`Invalid block timestamp for listing: ${blockTimestamp}`);
	}
	if (expiresAt <= blockTimestampMs) {
		throw protocolReject(`Listing expiresAt must be in the future for Asset: ${assetId}`);
	}

	const minimumExpiresAt = blockTimestampMs + MIN_LISTING_TTL_MS;
	if (expiresAt < minimumExpiresAt) {
		const minDays = MIN_LISTING_TTL_MS / 86_400_000;
		throw protocolReject(
			`Listing expiresAt is too soon: must be at least ${minDays} days (${MIN_LISTING_TTL_MS} ms) after the listing block timestamp`,
		);
	}

	const maximumExpiresAt = blockTimestampMs + MAX_LISTING_TTL_MS;
	if (expiresAt > maximumExpiresAt) {
		const maxDays = MAX_LISTING_TTL_MS / 86_400_000;
		throw protocolReject(
			`Listing expiresAt is too far in the future: must be at most ${maxDays} days (${MAX_LISTING_TTL_MS} ms) after the listing block timestamp`,
		);
	}
}

export async function handleList(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const assetId = requireString(op.data.assetId, "assetId");
	const listingId = requireString(op.data.listingId, "listingId");
	const listingNonce = requireString(op.data.listingNonce, "listingNonce");
	const price = requireHiveAmount(op.data.price, "price");
	const expiresAt = requireNumber(op.data.expiresAt, "expiresAt");
	// Bounded + typeof-checked at the boundary. generateListingId NFC-normalizes
	// and re-asserts the cap; this gate fails fast with a marketplace-specific
	// error rather than the generic "exceeds protocol cap" deeper in the call.
	const marketplace = optionalBoundedString(op.data.marketplace, "marketplace", MAX_MARKETPLACE_LENGTH);

	if (!listingId.startsWith(LISTING_ID_PREFIX)) {
		throw protocolReject(`Invalid listingId format: must start with '${LISTING_ID_PREFIX}'`);
	}

	const asset = await getAssetForProcessingForUpdate(assetId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${assetId}`);

	await validateSeedProvenance(op, asset, txn);

	assertActionable(asset, assetId);
	assertMarketplaceInstance(asset, assetId);

	validateExpiresAt(expiresAt, op.timestamp, assetId);

	const rules = await getCollectionRules(asset.collection_id, txn);
	if (rules && !rules.transferable) {
		throw protocolReject(`Collection ${asset.collection_id} is not transferable — listing blocked`);
	}

	const hadExpiredListing = asset.status === ASSET_STATUS_LISTED && isListingExpired(asset.listing_expires_at, op.timestamp);

	if (asset.status === ASSET_STATUS_LISTED && !hadExpiredListing) {
		throw protocolReject(`Asset is already listed. Unlist first: ${assetId}`);
	}

	if (asset.owner !== op.signer) throw protocolReject(`Signer ${op.signer} is not owner of ${assetId}`);

	// Verify listingId is correctly computed from the payload fields
	const expectedListingId = await generateListingId({
		assetId,
		owner: op.signer,
		marketplace: marketplace ?? "",
		priceAmount: price.amount,
		priceCurrency: price.currency,
		expiresAt,
		nonce: listingNonce,
	});

	if (listingId !== expectedListingId) {
		throw protocolReject(`listingId mismatch: expected '${expectedListingId}', got '${listingId}'`);
	}

	const priceAmount = parseFloat(price.amount);
	const minPrice = parseFloat(MIN_PRICE_AMOUNT);
	if (priceAmount < minPrice) {
		throw protocolReject(`Price ${price.amount} ${price.currency} is below minimum ${MIN_PRICE_AMOUNT}`);
	}

	const ctx: ListingCtx = {
		collectionId: asset.collection_id,
		wasListed: hadExpiredListing, // re-listing expired → net 0; fresh listing → +1
	};
	await updateAssetListing(assetId, priceAmount, price.currency, expiresAt, marketplace, listingId, op.txId, ctx, txn);
	await deleteAssetAllowance(assetId, txn);

	return [assetId];
}

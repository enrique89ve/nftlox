import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftListing, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import { requireString, requireHiveAmount, optionalNumber, optionalString } from "@/utils/validation.ts";
import { assertNotBurned, assertNotLent, isListingExpired } from "@/utils/status-checks.ts";

export async function handleList(op: ParsedOperation, txn: Queryable): Promise<void> {
	const nftId = requireString(op.data.nftId, "nftId");
	const price = requireHiveAmount(op.data.price, "price");
	const expiresAt = optionalNumber(op.data.expiresAt);
	const marketplace = optionalString(op.data.marketplace);

	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	assertNotBurned(nft, nftId);
	assertNotLent(nft, nftId);

	if (nft.status === NFT_STATUS_LISTED && !isListingExpired(nft.listing_expires_at, op.timestamp)) {
		throw new Error(`NFT is already listed. Unlist first: ${nftId}`);
	}

	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const priceAmount = parseFloat(price.amount);
	await updateNftListing(nftId, priceAmount, price.currency, expiresAt, marketplace, txn);
}

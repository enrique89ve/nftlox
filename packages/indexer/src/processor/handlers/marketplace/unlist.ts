import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getNftForProcessing, updateNftListing, NFT_STATUS_LISTED } from "@/db/queries/nfts.ts";
import type { ListingCtx } from "@/db/queries/nfts.ts";
import { requireString } from "@/utils/validation.ts";

export async function handleUnlist(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");
	const nft = await getNftForProcessing(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);
	if (nft.status !== NFT_STATUS_LISTED) throw new Error(`NFT not listed: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const ctx: ListingCtx = { collectionId: nft.collection_id, wasListed: true };
	await updateNftListing(nftId, null, null, null, null, null, null, ctx, txn);

	return [nftId];
}

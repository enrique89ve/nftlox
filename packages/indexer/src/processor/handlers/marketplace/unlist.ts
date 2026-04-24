import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getNftForProcessingForUpdate,
	updateNftListing,
	NFT_STATUS_LISTED,
} from "@/db/queries/nfts.ts";
import type { ListingCtx } from "@/db/queries/nfts.ts";
import { requireString } from "@/utils/validation.ts";
import { assertNotPendingSale } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";

/**
 * Unlist is instantaneous. Any active buy settlement is projected as a
 * `status='pending_sale'` row by `handleBuyCommitment`; `handleUnlist`
 * refuses to touch those. Unlisting a row still in `status='listed'` is
 * therefore safe to materialize immediately — the commitment gate has
 * already enforced exclusivity.
 */
export async function handleUnlist(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const nftId = requireString(op.data.nftId, "nftId");

	const nft = await getNftForProcessingForUpdate(nftId, txn);
	if (!nft) throw new Error(`NFT not found: ${nftId}`);

	await validateSeedProvenance(op, nft, txn);

	assertNotPendingSale(nft, nftId);
	if (nft.status !== NFT_STATUS_LISTED) throw new Error(`NFT not listed: ${nftId}`);
	if (nft.owner !== op.signer) throw new Error(`Signer ${op.signer} is not owner of ${nftId}`);

	const ctx: ListingCtx = {
		collectionId: nft.collection_id,
		wasListed: true,
	};
	await updateNftListing(nftId, null, null, null, null, null, null, ctx, txn);

	return [nftId];
}

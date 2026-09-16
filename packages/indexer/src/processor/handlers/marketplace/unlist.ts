import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	getAssetForProcessingForUpdate,
	updateAssetListing,
	ASSET_STATUS_LISTED,
} from "@/db/queries/assets.ts";
import type { ListingCtx } from "@/db/queries/assets.ts";
import { requireString } from "@/utils/validation.ts";
import { assertNotPendingSale } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

/**
 * Unlist is instantaneous. Any active buy settlement is projected as a
 * `status='pending_sale'` row by `handleBuyCommitment`; `handleUnlist`
 * refuses to touch those. Unlisting a row still in `status='listed'` is
 * therefore safe to materialize immediately — the commitment gate has
 * already enforced exclusivity.
 */
export async function handleUnlist(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const assetId = requireString(op.data.assetId, "assetId");

	const asset = await getAssetForProcessingForUpdate(assetId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${assetId}`);

	await validateSeedProvenance(op, asset, txn);

	assertNotPendingSale(asset, assetId);
	if (asset.status !== ASSET_STATUS_LISTED) throw protocolReject(`Asset not listed: ${assetId}`);
	if (asset.owner !== op.signer) throw protocolReject(`Signer ${op.signer} is not owner of ${assetId}`);

	const ctx: ListingCtx = {
		collectionId: asset.collection_id,
		wasListed: true,
	};
	await updateAssetListing(assetId, null, null, null, null, null, null, ctx, txn);

	return [assetId];
}

import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getAssetForProcessing } from "@/db/queries/assets.ts";
import { upsertAssetAllowance, deleteAssetAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";
import { assertActionable, assertNotSeed, assertNotListed, assertNotPendingSale } from "@/utils/status-checks.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleAssetApprove(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const spender = requireUsername(op.data.spender, "spender");
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw protocolReject("Cannot approve yourself");

	const asset = await getAssetForProcessing(instanceId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${instanceId}`);

	assertActionable(asset, instanceId);
	assertNotSeed(asset, instanceId);
	// An Asset in `listed` status is committed to the marketplace buy flow. Granting
	// (or revoking) a separate spender allowance at the same time creates two races
	// that contend for the same Asset: the marketplace `buy` and a potential
	// `asset_transfer_from`. The transfer-from handler also blocks listed Assets, but
	// rejecting at approve time is the hygienic fix — the owner must unlist first
	// before delegating, making the authorization chain linear instead of ambiguous.
	assertNotListed(asset, instanceId);
	// Same reasoning applies mid-settlement: while a buy_commitment holds the Asset
	// in `pending_sale`, the buyer's transfers are already signed. Granting a new
	// allowance here has no effect on the imminent buy (updateAssetOwner clears all
	// allowances on settlement) but leaves a lingering approval if the commitment
	// expires without settling. Reject for the same hygiene reason as `listed`.
	assertNotPendingSale(asset, instanceId);

	if (asset.owner !== op.signer) throw protocolReject(`Signer ${op.signer} is not owner of ${instanceId}`);

	if (approved) {
		await upsertAssetAllowance(instanceId, op.signer, spender, op.blockNum, op.txId, txn);
	} else {
		await deleteAssetAllowance(instanceId, txn);
	}

	return [instanceId];
}

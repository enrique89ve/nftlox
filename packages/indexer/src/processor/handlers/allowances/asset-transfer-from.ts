import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getAssetForProcessingForUpdate, updateAssetOwner } from "@/db/queries/assets.ts";
import type { OwnerChangeCtx } from "@/db/queries/assets.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import {
	getAssetAllowance,
	hasCollectionAllowance,
	deleteAssetAllowance,
	cleanupCollectionAllowancesIfEmpty,
} from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertOwnershipChangeable, assertNotPendingSale, assertNotSeed } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { createLogger } from "@/utils/logger.ts";
import { BURN_RECIPIENT, ACTION_ASSET_TRANSFER_FROM } from "@/protocol/index.ts";
import {
	DELEGATED_BURN_REJECTION_REASON,
	protocolReject,
} from "@/processor/protocol-rejection.ts";

const log = createLogger("handler:asset-transfer-from");

export async function handleAssetTransferFrom(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const from = requireUsername(op.data.from, "from");
	const to = requireUsername(op.data.to, "to");
	const instanceId = requireString(op.data.instanceId, "instanceId");
	if (to === BURN_RECIPIENT) {
		throw protocolReject(DELEGATED_BURN_REJECTION_REASON, "BURN_RECIPIENT_DELEGATION_FORBIDDEN");
	}

	if (from === to) throw protocolReject("Cannot transfer to yourself");

	const asset = await getAssetForProcessingForUpdate(instanceId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${instanceId}`);

	await validateSeedProvenance(op, asset, txn);

	// Delegated transfer on a `pending_sale` row would race the buy_commitment
	// of another buyer. Reject before we touch allowance tables so the
	// savepoint rolls back clean.
	assertNotPendingSale(asset, instanceId);

	const { hadExpiredListing } = assertOwnershipChangeable(asset, instanceId, op.timestamp);
	if (hadExpiredListing) {
		log.info("TransferFrom auto-cleared expired listing", { instanceId, block: op.blockNum });
	}
	assertNotSeed(asset, instanceId);

	if (asset.owner !== from) throw protocolReject(`Account ${from} is not owner of ${instanceId}`);

	const rules = await getCollectionRules(asset.collection_id, txn);
	if (rules && !rules.transferable) {
		throw protocolReject(`Collection ${asset.collection_id} is not transferable`);
	}

	// Spender authorization: individual Asset approval OR collection-wide approval
	const approvedSpender = await getAssetAllowance(instanceId, txn);
	const hasIndividualApproval = approvedSpender === op.signer;
	const hasCollectionApproval = await hasCollectionAllowance(
		from, op.signer, asset.collection_id, txn,
	);

	if (!hasIndividualApproval && !hasCollectionApproval) {
		throw protocolReject(`Signer ${op.signer} is not approved to transfer ${instanceId}`);
	}

	const ctx: OwnerChangeCtx = {
		oldOwner: asset.owner,
		assetType: asset.asset_type,
		collectionId: asset.collection_id,
		ownerAction: ACTION_ASSET_TRANSFER_FROM,
		ownerBlockNum: op.blockNum,
		wasListed: hadExpiredListing,
	};
	await updateAssetOwner(instanceId, to, op.operationId, ctx, txn);
	await deleteAssetAllowance(instanceId, txn);
	// Invariant A4': collection_allowances(owner=X, collection=Y) MUST be
	// revoked the moment owner_count(X, Y) transitions to 0 — regardless of
	// which action caused it. If `from` emptied their holdings in this
	// collection via this delegated transfer, keeping the approval would
	// create a zombie authority that silently re-activates the next time
	// `from` acquires any Asset in the same collection.
	await cleanupCollectionAllowancesIfEmpty(from, asset.collection_id, txn);

	return [instanceId];
}

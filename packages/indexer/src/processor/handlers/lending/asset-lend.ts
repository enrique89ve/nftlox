import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getAssetForProcessingForUpdate, updateAssetStatus, ASSET_STATUS_ACTIVE, ASSET_STATUS_LENT } from "@/db/queries/assets.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { insertLoan, getLoan } from "@/db/queries/loans.ts";
import { deleteAssetAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireUsername } from "@/utils/validation.ts";
import { assertNotSeed } from "@/utils/status-checks.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleAssetLend(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const instanceId = requireString(op.data.instanceId, "instanceId");
	const borrower = requireUsername(op.data.borrower, "borrower");

	if (borrower === op.signer) throw protocolReject("Cannot lend to yourself");

	const asset = await getAssetForProcessingForUpdate(instanceId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${instanceId}`);

	await validateSeedProvenance(op, asset, txn);

	if (asset.status !== ASSET_STATUS_ACTIVE) throw protocolReject(`Asset must be active to lend, current status: ${asset.status}`);
	assertNotSeed(asset, instanceId);
	if (asset.owner !== op.signer) throw protocolReject(`Signer ${op.signer} is not owner of ${instanceId}`);

	const rules = await getCollectionRules(asset.collection_id, txn);
	if (rules && !rules.transferable) {
		throw protocolReject(`Collection ${asset.collection_id} is not transferable — lending not allowed`);
	}

	const existingLoan = await getLoan(instanceId, txn);
	if (existingLoan) throw protocolReject(`Asset already lent: ${instanceId}`);

	await updateAssetStatus(instanceId, ASSET_STATUS_LENT, txn);
	await insertLoan({
		assetId: instanceId,
		lender: op.signer,
		borrower,
		operationId: op.operationId,
		blockNum: op.blockNum,
		txId: op.txId,
	}, txn);

	// Clear any existing approvals — lent Assets cannot be transferred
	await deleteAssetAllowance(instanceId, txn);

	return [instanceId];
}

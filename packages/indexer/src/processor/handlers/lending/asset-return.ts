import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getAssetForProcessingForUpdate, updateAssetStatus, ASSET_STATUS_ACTIVE, ASSET_STATUS_LENT } from "@/db/queries/assets.ts";
import { getLoan, deleteLoan } from "@/db/queries/loans.ts";
import { requireString } from "@/utils/validation.ts";
import { validateSeedProvenance } from "@/utils/seed-provenance.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleAssetReturn(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const instanceId = requireString(op.data.instanceId, "instanceId");

	const asset = await getAssetForProcessingForUpdate(instanceId, txn);
	if (!asset) throw protocolReject(`Asset not found: ${instanceId}`);

	await validateSeedProvenance(op, asset, txn);

	if (asset.status !== ASSET_STATUS_LENT) throw protocolReject(`Asset is not lent: ${instanceId}`);

	const loan = await getLoan(instanceId, txn);
	if (!loan) throw protocolReject(`No active loan found for: ${instanceId}`);

	// Both lender and borrower can return
	const isLender = op.signer === loan.lender;
	const isBorrower = op.signer === loan.borrower;
	if (!isLender && !isBorrower) {
		throw protocolReject(`Signer ${op.signer} is neither lender nor borrower of ${instanceId}`);
	}

	await updateAssetStatus(instanceId, ASSET_STATUS_ACTIVE, txn);
	await deleteLoan(instanceId, txn);

	return [instanceId];
}

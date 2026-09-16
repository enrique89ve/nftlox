import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { getCollectionRules } from "@/db/queries/collections.ts";
import { upsertCollectionAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";
import { protocolReject } from "@/processor/protocol-rejection.ts";

export async function handleAssetApproveAll(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const spender = requireUsername(op.data.spender, "spender");
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw protocolReject("Cannot approve yourself");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw protocolReject(`Collection not found: ${collectionId}`);

	if (approved) {
		// Only allow approveAll if the signer owns at least one Asset in this collection
		const [row] = await txn`
			SELECT 1 FROM assets
			WHERE owner = ${op.signer} AND collection_id = ${collectionId}
			LIMIT 1
		`;
		if (!row) throw protocolReject(`Signer ${op.signer} has no Assets in collection ${collectionId}`);
	}

	await upsertCollectionAllowance(
		op.signer, spender, collectionId, approved,
		op.blockNum, op.txId, txn,
	);

	return [];
}

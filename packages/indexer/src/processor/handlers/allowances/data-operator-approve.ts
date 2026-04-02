import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	COLLECTION_STATUS_ARCHIVED,
	getCollectionRules,
} from "@/db/queries/collections.ts";
import { upsertDataOperator, deleteDataOperator } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";

export async function handleDataOperatorApprove(op: ParsedOperation, txn: Queryable): Promise<void> {
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const operator = requireUsername(op.data.operator, "operator");
	const approved = requireBoolean(op.data.approved, "approved");

	if (operator === op.signer) throw new Error("Cannot approve yourself as operator");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not creator of collection ${collectionId}`);
	}
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	if (approved) {
		await upsertDataOperator(collectionId, operator, op.blockNum, op.txId, txn);
	} else {
		await deleteDataOperator(collectionId, operator, txn);
	}
}

import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	COLLECTION_STATUS_ARCHIVED,
	getCollectionRules,
} from "@/db/queries/collections.ts";
import { upsertCollectionAllowance } from "@/db/queries/allowances.ts";
import { requireString, requireBoolean, requireUsername } from "@/utils/validation.ts";



export async function handleNftApproveAll(op: ParsedOperation, txn: Queryable): Promise<void> {
	const spender = requireUsername(op.data.spender, "spender");
	const collectionId = requireString(op.data.collectionId, "collectionId");
	const approved = requireBoolean(op.data.approved, "approved");

	if (spender === op.signer) throw new Error("Cannot approve yourself");

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	await upsertCollectionAllowance(
		op.signer, spender, collectionId, approved,
		op.blockNum, op.txId, txn,
	);
}
